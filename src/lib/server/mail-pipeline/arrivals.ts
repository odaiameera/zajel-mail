import type { JMAPClient } from '$lib/jmap/client';
import type { MethodCall } from '$lib/jmap/types';
import { getDb } from '$lib/server/db/index';
import { enqueueEmails } from '$lib/server/db/queries/jev-decisions';

/**
 * Where the pipeline has read up to, and the new mail it has seen.
 *
 * One cursor per account (`mail_pipeline`) says how far the Inbox (and
 * Junk, while the spam add-on is on) has been read. Each message found
 * after it is recorded once in `mail_arrivals`; that table, not memory, is
 * what keeps a message from being handled twice, across the short look-back
 * each pass makes, a restart, or a pass that failed part-way and is tried
 * again.
 */

/** Messages read per mailbox per pass. */
export const DISCOVERY_PAGE = 100;
/** How far each pass looks back past its own start; see nextCursor. */
export const LOOKBACK_MS = 60_000;
/** Passes an arrival is tried in before it is given up on. */
export const MAX_ARRIVAL_ATTEMPTS = 5;
/** Arrivals unhandled from earlier passes, taken up per pass. */
const UNHANDLED_PAGE = 200;
/** How long an arrival is remembered. */
export const KEEP_ARRIVALS_MS = 7 * 24 * 60 * 60_000;

export type ArrivalMailbox = 'inbox' | 'junk';

export interface Arrival {
	emailId: string;
	mailbox: ArrivalMailbox;
	receivedAt: string;
	/** Passes that have tried it already. */
	attempts: number;
}

let _stmts: ReturnType<typeof prepareStmts> | null = null;

/** Prepared lazily, as in the query modules (see db/queries/jev-settings.ts). */
function prepareStmts() {
	const db = getDb();
	return {
		getCursor: db.prepare('SELECT cursor FROM mail_pipeline WHERE account_id = ?'),
		setCursor: db.prepare(
			`INSERT INTO mail_pipeline (account_id, cursor, updated_at) VALUES (?, ?, ?)
			 ON CONFLICT (account_id) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at`
		),
		record: db.prepare(
			`INSERT INTO mail_arrivals (account_id, email_id, mailbox, received_at, seen_at)
			 VALUES (?, ?, ?, ?, ?) ON CONFLICT (account_id, email_id) DO NOTHING`
		),
		unhandled: db.prepare(
			`SELECT email_id, mailbox, received_at, attempts FROM mail_arrivals
			 WHERE account_id = ? AND handled_at IS NULL
			 ORDER BY seen_at, received_at, email_id LIMIT ?`
		),
		attempt: db.prepare(
			`UPDATE mail_arrivals SET attempts = attempts + 1 WHERE account_id = ? AND email_id = ? AND handled_at IS NULL`
		),
		handle: db.prepare(
			`UPDATE mail_arrivals SET handled_at = ?, rules_json = ? WHERE account_id = ? AND email_id = ? AND handled_at IS NULL`
		),
		prune: db.prepare('DELETE FROM mail_arrivals WHERE seen_at < ?')
	};
}
function stmts() {
	return (_stmts ??= prepareStmts());
}

/** Where the account's pipeline has read up to, or null before its first pass. */
export function getCursor(accountRowId: string): string | null {
	return (stmts().getCursor.get(accountRowId) as { cursor: string | null } | undefined)?.cursor ?? null;
}

export function setCursor(accountRowId: string, iso: string, now = new Date()): void {
	stmts().setCursor.run(accountRowId, iso, now.getTime());
}

export interface Discovered {
	emailId: string;
	mailbox: ArrivalMailbox;
	receivedAt: string;
}

/**
 * Mail received after `cursor` in the watched mailboxes, oldest first, a
 * page each; and where the cursor goes next.
 */
export async function discover(
	client: JMAPClient,
	accountId: string,
	watched: { mailbox: ArrivalMailbox; id: string }[],
	cursor: string,
	now: Date
): Promise<{ found: Discovered[]; nextCursor: string }> {
	const response = await client.request(
		watched.flatMap(({ id }, i): MethodCall[] => [
			[
				'Email/query',
				{
					accountId,
					filter: { operator: 'AND', conditions: [{ inMailbox: id }, { after: cursor }] },
					sort: [{ property: 'receivedAt', isAscending: true }],
					limit: DISCOVERY_PAGE
				},
				`q${i}`
			],
			[
				'Email/get',
				{
					accountId,
					'#ids': { resultOf: `q${i}`, name: 'Email/query', path: '/ids' },
					properties: ['id', 'receivedAt']
				},
				`g${i}`
			]
		])
	);
	const found: Discovered[] = [];
	// A full page may have more behind it: resume from the earliest last-seen.
	const resumeAt: string[] = [];
	for (const [name, result, tag] of response.methodResponses) {
		if (name !== 'Email/get') continue;
		const mailbox = watched[Number(tag.slice(1))]?.mailbox ?? 'inbox';
		const list = (result as { list?: { id: string; receivedAt: string }[] }).list ?? [];
		for (const e of list) found.push({ emailId: e.id, mailbox, receivedAt: e.receivedAt });
		if (list.length >= DISCOVERY_PAGE) resumeAt.push(list[list.length - 1].receivedAt);
	}
	return { found, nextCursor: nextCursor(cursor, resumeAt.sort()[0], now) };
}

/**
 * Stalwart stamps receivedAt to the second and `after` is strict, so a
 * cursor at this pass's own instant would never again match mail landing
 * later in the same second. The cursor is set a minute back instead: what
 * the next pass reads again is already recorded and is not handled twice,
 * and the cursor never goes back past where it was.
 *
 * After a full page it steps back a second from the page's last message,
 * for ties, unless the whole page is that one second: then stepping back
 * would never move it on.
 */
export function nextCursor(cursor: string, lastSeen: string | undefined, now: Date): string {
	if (lastSeen) {
		return Date.parse(lastSeen) - 1000 > Date.parse(cursor) ? new Date(Date.parse(lastSeen) - 1000).toISOString() : lastSeen;
	}
	return new Date(Math.max(Date.parse(cursor), now.getTime() - LOOKBACK_MS)).toISOString();
}

/** Record what was found; returns how many were new. */
export function recordArrivals(accountRowId: string, found: Discovered[], now = new Date()): number {
	const s = stmts();
	let added = 0;
	getDb().transaction(() => {
		for (const f of found) added += s.record.run(accountRowId, f.emailId, f.mailbox, f.receivedAt, now.getTime()).changes;
	})();
	return added;
}

/** Arrivals not yet handled, oldest first. */
export function listUnhandled(accountRowId: string, limit = UNHANDLED_PAGE): Arrival[] {
	return (
		stmts().unhandled.all(accountRowId, limit) as { email_id: string; mailbox: ArrivalMailbox; received_at: string; attempts: number }[]
	).map((r) => ({ emailId: r.email_id, mailbox: r.mailbox, receivedAt: r.received_at, attempts: r.attempts }));
}

/** A pass is about to try these: counted before it starts, so a pass that dies part-way still counts. */
export function countAttempt(accountRowId: string, emailIds: string[]): void {
	const s = stmts();
	getDb().transaction(() => {
		for (const id of emailIds) s.attempt.run(accountRowId, id);
	})();
}

/**
 * Mark arrivals handled, with the rules that matched each, and queue the
 * ones Jev is to see, in one transaction: an arrival is never handled
 * without being queued, nor (if this fails) queued and then handled again.
 */
export function markHandled(
	accountRowId: string,
	handled: { emailId: string; rules?: string[] }[],
	queueForJev: string[] = [],
	now = new Date()
): void {
	const s = stmts();
	getDb().transaction(() => {
		if (queueForJev.length) enqueueEmails(accountRowId, queueForJev, now.getTime());
		for (const h of handled) {
			s.handle.run(now.getTime(), h.rules?.length ? JSON.stringify(h.rules) : null, accountRowId, h.emailId);
		}
	})();
}

/** The daily pass: forget arrivals seen more than a week ago. */
export function pruneArrivals(now = new Date()): number {
	return stmts().prune.run(now.getTime() - KEEP_ARRIVALS_MS).changes;
}
