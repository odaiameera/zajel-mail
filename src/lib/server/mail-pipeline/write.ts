import { JMAPAuthError, type JMAPClient } from '$lib/jmap/client';
import type { Email, Mailbox } from '$lib/jmap/types';
import { EMAIL_SET_BATCH } from '$lib/jmap/email';
import { getMailboxes } from '$lib/jmap/mailbox';
import { categoryOf, type InboxCategory } from '$lib/types/categories';
import { hasUnknownMailbox } from '$lib/mailboxes';
import { JEV_SORTED_KEYWORD } from '$lib/inbox-hold';
import { emptyOutcome, outcomeToUpdate, type RuleOutcome } from '$lib/server/rules/engine';
import { errorFields } from '$lib/server/log';
import { noteFailure, noteRecovered } from '$lib/server/jev/health';

/**
 * Writing what a pass decided about new mail. Every write goes through
 * `flush`, which first reads again where each message is: a message that
 * has left the mailbox it was found in is not touched (your move wins); one
 * whose tab changed keeps the rules' changes but not Jev's tab or spam
 * move; and what is written is worked out against where the message is
 * now, so only real differences go out. Batched Email/set, the server's
 * refusals kept with its reason, and one log line per pass.
 */

/** What a pass wants done to one message. */
export interface Change {
	/** The mailbox it was found in. A message that has left it is left alone. */
	home: string;
	/** Its tab when this was decided. A message whose tab changed since keeps it. */
	tabWas: InboxCategory;
	/** What the rules do: a move, labels, read, star. Kept even if the tab changed. */
	rules?: RuleOutcome;
	/** What Jev's step does: the tab's keywords, a move to or from Junk. */
	jev?: RuleOutcome;
	/** The "sorted" marker that ends the Inbox's hold: set whenever the message is still in the Inbox. */
	marker?: boolean;
}

/** One pass's writing: the account, its mailboxes (fetched again at most once), and its writes for the log. */
export interface WriteContext {
	client: JMAPClient;
	accountId: string;
	accountRowId: string;
	inboxId: string;
	/** Every mailbox on the account, for the filing rules a move follows. */
	mailboxes: Mailbox[];
	/** Whether `mailboxes` has been fetched again in this pass (at most once). */
	mailboxesRefreshed: boolean;
	writes: WriteOutcome;
}

const hasWork = (o: RuleOutcome | undefined) =>
	!!o && (o.moveTo !== null || o.labels.size > 0 || Object.keys(o.keywords).length > 0);

/** Put together two changes to one message: the rules' move wins, labels and keywords add up. */
function merge(a: RuleOutcome | undefined, b: RuleOutcome | undefined): RuleOutcome {
	const out = emptyOutcome();
	for (const o of [a, b]) {
		if (!o) continue;
		out.moveTo ??= o.moveTo;
		for (const l of o.labels) out.labels.add(l);
		Object.assign(out.keywords, o.keywords);
		out.firedRuleIds.push(...o.firedRuleIds);
	}
	return out;
}

/** Add `part` to the change already set for `id`, if any. */
export function addChange(changes: Map<string, Change>, id: string, part: Change): void {
	const had = changes.get(id);
	if (!had) {
		changes.set(id, part);
		return;
	}
	changes.set(id, {
		home: had.home,
		tabWas: had.tabWas,
		rules: had.rules || part.rules ? merge(had.rules, part.rules) : undefined,
		jev: had.jev || part.jev ? merge(had.jev, part.jev) : undefined,
		marker: had.marker || part.marker
	});
}

export interface Flushed {
	/** Why each message that wasn't written wasn't. */
	notWritten: Map<string, string>;
	/** Messages moved, or put in another tab, since: Jev's part of their change was not applied. */
	moved: Set<string>;
}

/**
 * Write a set of changes, after reading again where each message is.
 */
export async function flush(ctx: WriteContext, changes: Map<string, Change>): Promise<Flushed> {
	const withWork = [...changes].filter(([, c]) => hasWork(c.rules) || hasWork(c.jev) || c.marker);
	const moved = new Set<string>();
	if (withWork.length === 0) return { notWritten: new Map(), moved };
	const placement = await currentPlacement(ctx.client, ctx.accountId, withWork.map(([id]) => id));
	// The mailbox list is from the start of the pass. A message now in a
	// mailbox it doesn't know (a label made meanwhile) needs a fresh one, or
	// a move couldn't tell that label from a folder. Once per pass at most.
	if (!ctx.mailboxesRefreshed && hasUnknownMailbox([...placement.values()].map((p) => p.mailboxIds), ctx.mailboxes)) {
		ctx.mailboxes = await getMailboxes(ctx.client, ctx.accountId);
		ctx.mailboxesRefreshed = true;
	}
	const updates: [string, Record<string, unknown>][] = [];
	const markerOnly = { [`keywords/${JEV_SORTED_KEYWORD}`]: true };
	for (const [id, change] of withWork) {
		const current = placement.get(id);
		if (!current?.mailboxIds[change.home]) {
			// Moved by you (or deleted) since: left as it was put. Still done
			// with, so if it is in the Inbox now it isn't held.
			moved.add(id);
			if (change.marker && current?.mailboxIds[ctx.inboxId] && !current.keywords[JEV_SORTED_KEYWORD]) {
				updates.push([id, markerOnly]);
			}
			continue;
		}
		// Put in another tab since: your tab stands, and so does a message
		// you kept in the Inbox; the rules' own changes still go on.
		const tabChanged = categoryOf(current.keywords) !== change.tabWas;
		if (tabChanged && change.jev) moved.add(id);
		const outcome = merge(change.rules, tabChanged ? undefined : change.jev);
		if (change.marker && (outcome.moveTo === null || outcome.moveTo === ctx.inboxId)) {
			outcome.keywords[JEV_SORTED_KEYWORD] = true;
		}
		const update = outcomeToUpdate(current, outcome, ctx.mailboxes);
		if (Object.keys(update).length > 0) updates.push([id, update]);
	}
	const notWritten = await writeUpdates(ctx.client, ctx.accountId, updates, ctx.writes);
	return { notWritten, moved };
}

type Placement = Pick<Email, 'mailboxIds' | 'keywords'>;

/** Where each message is, and which tab it has, right now; one the server no longer has is absent. */
async function currentPlacement(client: JMAPClient, accountId: string, ids: string[]): Promise<Map<string, Placement>> {
	if (ids.length === 0) return new Map();
	const response = await client.request([
		['Email/get', { accountId, ids, properties: ['id', 'mailboxIds', 'keywords'] }, 'p']
	]);
	const list = (response.methodResponses[0][1] as { list?: (Placement & { id: string })[] }).list ?? [];
	return new Map(list.map((e) => [e.id, { mailboxIds: e.mailboxIds ?? {}, keywords: e.keywords ?? {} }]));
}

/**
 * A SetError as one short line: its type, what the server said, and which
 * properties. It is the server's text, of whatever shape, so nothing about
 * it is trusted, and it is cut to the length errorFields keeps.
 */
function refusalText(err: unknown): string {
	const e = (err && typeof err === 'object' ? err : {}) as Record<string, unknown>;
	const what = [e.type, e.description].filter((v) => v != null && v !== '').map(String).join(': ') || 'no reason given';
	const props = Array.isArray(e.properties) ? ` (${e.properties.map(String).join(', ')})` : '';
	return `${what}${props}`.slice(0, 300);
}

/** What a pass's writes came to, for its one log line. */
interface WriteOutcome {
	attempted: number;
	refused: number;
	/** The first refusal's reason. */
	refusal: string | null;
	/** The first write that got no answer from the server. */
	unreachable: unknown;
}

export const noWrites = (): WriteOutcome => ({ attempted: 0, refused: 0, refusal: null, unreachable: null });

/**
 * Write updates in batches; returns what to record for each message not
 * updated. A refused tab or label never reaches the message, and "refused"
 * alone can't tell a patch the server can't read from a message that's
 * gone, so the server's reason is kept. A write that got no answer is not a
 * refusal (after a timeout it may even have landed), and is recorded as such.
 */
async function writeUpdates(
	client: JMAPClient,
	accountId: string,
	updates: [string, Record<string, unknown>][],
	outcome: WriteOutcome
): Promise<Map<string, string>> {
	const failed = new Map<string, string>();
	outcome.attempted += updates.length;
	for (let i = 0; i < updates.length; i += EMAIL_SET_BATCH) {
		const chunk = updates.slice(i, i + EMAIL_SET_BATCH);
		let notUpdated: unknown;
		try {
			const res = await client.request([
				['Email/set', { accountId, update: Object.fromEntries(chunk) }, '0']
			]);
			notUpdated = (res.methodResponses[0][1] as { notUpdated?: unknown }).notUpdated;
		} catch (err) {
			if (err instanceof JMAPAuthError) throw err;
			outcome.unreachable ??= err;
			const reason = `Couldn’t reach the mail server: ${errorFields(err).error}`;
			for (const [id] of chunk) failed.set(id, reason);
			continue;
		}
		if (!notUpdated || typeof notUpdated !== 'object') continue;
		for (const [id, err] of Object.entries(notUpdated)) {
			const reason = refusalText(err);
			outcome.refused++;
			outcome.refusal ??= reason;
			failed.set(id, `The mail server refused the change: ${reason}`);
		}
	}
	return failed;
}

/**
 * Log a pass's writes once, after all its batches: a pass that keeps
 * refusing new mail while sorting existing mail fine is still failing, not
 * recovering, and logging per batch said both every minute.
 */
export function noteWrites(accountRowId: string, w: WriteOutcome): void {
	if (w.unreachable) noteFailure('write', accountRowId, 'write_failed', errorFields(w.unreachable), 'mail');
	else if (w.refusal) noteFailure('write', accountRowId, 'write_refused', { count: w.refused, error: w.refusal }, 'mail');
	else if (w.attempted) noteRecovered('write', accountRowId, 'write_recovered', 'mail');
}
