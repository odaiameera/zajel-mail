import { getDb } from '../index';
import type { InboxCategory } from '$lib/types/categories';

/**
 * Jev's per-email decisions and the per-month usage counter. See migration
 * 012_jev_sorting.sql for what is (and deliberately isn't) stored.
 */

/** Attempts before an email Jev keeps failing on is given up on. */
export const MAX_JEV_ATTEMPTS = 5;

export interface JevDecisionRow {
	emailId: string;
	status: 'pending' | 'done' | 'failed' | 'skipped';
	attempts: number;
	lastError: string | null;
	category: InboxCategory | null;
	confidence: number | null;
	applied: InboxCategory | null;
	answers: Record<string, unknown> | null;
	facts: Record<string, unknown> | null;
	model: string | null;
	inputTokens: number | null;
	correctedTo: InboxCategory | null;
	/** The sender pin that decided the tab, when one did. */
	pinnedBy: string | null;
	/** Jev's spam answers, when spam checking was on. */
	spam: number | null;
	phishing: number | null;
	/** Stalwart had flagged it, or filed it in Junk. */
	stalwartSpam: boolean | null;
	/** 'junked' | 'rescued' | 'flagged', or in watch mode 'would_junk' | 'would_rescue' | 'would_flag'. */
	spamAction: string | null;
	/** 'spam' or 'ham' when you marked it afterwards. */
	spamCorrectedTo: string | null;
	createdAt: number;
	decidedAt: number | null;
}

interface RawRow {
	email_id: string;
	status: JevDecisionRow['status'];
	attempts: number;
	last_error: string | null;
	category: string | null;
	confidence: number | null;
	applied: string | null;
	answers_json: string | null;
	facts_json: string | null;
	model: string | null;
	input_tokens: number | null;
	corrected_to: string | null;
	pinned_by: string | null;
	spam: number | null;
	phishing: number | null;
	stalwart_spam: number | null;
	spam_action: string | null;
	spam_corrected_to: string | null;
	created_at: number;
	decided_at: number | null;
}

function parseJson(raw: string | null): Record<string, unknown> | null {
	if (!raw) return null;
	try {
		return JSON.parse(raw) as Record<string, unknown>;
	} catch {
		return null;
	}
}

function toRow(r: RawRow): JevDecisionRow {
	return {
		emailId: r.email_id,
		status: r.status,
		attempts: r.attempts,
		lastError: r.last_error,
		category: r.category as InboxCategory | null,
		confidence: r.confidence,
		applied: r.applied as InboxCategory | null,
		answers: parseJson(r.answers_json),
		facts: parseJson(r.facts_json),
		model: r.model,
		inputTokens: r.input_tokens,
		correctedTo: r.corrected_to as InboxCategory | null,
		pinnedBy: r.pinned_by,
		spam: r.spam,
		phishing: r.phishing,
		stalwartSpam: r.stalwart_spam === null ? null : r.stalwart_spam === 1,
		spamAction: r.spam_action,
		spamCorrectedTo: r.spam_corrected_to,
		createdAt: r.created_at,
		decidedAt: r.decided_at
	};
}

let _stmts: ReturnType<typeof prepareStmts> | null = null;

/** Prepared lazily, as in the other query modules (see jev-settings.ts). */
function prepareStmts() {
	const db = getDb();
	return {
		// A new arrival is queued once. The one row it may revive is the record
		// of a tab you chose before the pass queued it (done, with no answer of
		// Jev's): it is still checked for spam and urgency, tab aside.
		enqueue: db.prepare(
			`INSERT INTO jev_decisions (account_id, email_id, status, backfill, created_at)
			 VALUES (?, ?, 'pending', ?, ?)
			 ON CONFLICT (account_id, email_id) DO UPDATE SET
			   status = 'pending', created_at = excluded.created_at, decided_at = NULL
			 WHERE jev_decisions.status = 'done' AND jev_decisions.answers_json IS NULL`
		),
		// Sorting existing mail offers skipped and failed mail again: it is
		// still sitting in the Inbox unsorted. Its row starts over, so a
		// message that failed for good once gets its full share of attempts.
		enqueueBackfill: db.prepare(
			`INSERT INTO jev_decisions (account_id, email_id, status, backfill, created_at)
			 VALUES (?, ?, 'pending', 1, ?)
			 ON CONFLICT (account_id, email_id) DO UPDATE SET
			   status = 'pending', backfill = 1, created_at = excluded.created_at,
			   attempts = 0, last_error = NULL, decided_at = NULL
			 WHERE jev_decisions.status IN ('skipped', 'failed')`
		),
		pending: db.prepare(
			`SELECT email_id FROM jev_decisions
			 WHERE account_id = ? AND status = 'pending' AND backfill = ?
			 ORDER BY created_at, email_id LIMIT ?`
		),
		backfillProgress: db.prepare(
			`SELECT status, COUNT(*) AS n FROM jev_decisions
			 WHERE account_id = ? AND backfill = 1 GROUP BY status`
		),
		cancelBackfill: db.prepare(
			`UPDATE jev_decisions SET status = 'skipped', decided_at = ?
			 WHERE account_id = ? AND backfill = 1 AND status = 'pending'`
		),
		dropQueue: db.prepare(
			`UPDATE jev_decisions SET status = 'skipped', decided_at = ?
			 WHERE account_id = ? AND status = 'pending'`
		),
		done: db.prepare(
			`UPDATE jev_decisions SET
			   status = 'done', last_error = NULL, attempts = attempts + 1,
			   category = @category, confidence = @confidence, applied = @applied,
			   answers_json = @answers, facts_json = @facts, pinned_by = @pinnedBy, model = @model,
			   spam = @spam, phishing = @phishing, stalwart_spam = @stalwartSpam, spam_action = @spamAction,
			   input_tokens = @inputTokens, decided_at = @now
			 WHERE account_id = @accountId AND email_id = @emailId`
		),
		skip: db.prepare(
			`UPDATE jev_decisions SET status = 'skipped', decided_at = ?
			 WHERE account_id = ? AND email_id = ?`
		),
		fail: db.prepare(
			`UPDATE jev_decisions SET
			   attempts = attempts + 1, last_error = @error,
			   status = CASE WHEN attempts + 1 >= @max THEN 'failed' ELSE 'pending' END,
			   decided_at = CASE WHEN attempts + 1 >= @max THEN @now ELSE decided_at END
			 WHERE account_id = @accountId AND email_id = @emailId`
		),
		get: db.prepare(`SELECT * FROM jev_decisions WHERE account_id = ? AND email_id = ?`),
		correctSpam: db.prepare(
			`UPDATE jev_decisions SET spam_corrected_to = ?
			 WHERE account_id = ? AND email_id = ? AND spam IS NOT NULL`
		),
		spamRows: db.prepare(
			`SELECT email_id, spam, phishing, stalwart_spam, spam_action, spam_corrected_to
			 FROM jev_decisions
			 WHERE account_id = ? AND status = 'done' AND spam IS NOT NULL AND decided_at >= ?
			 ORDER BY decided_at DESC`
		),
		// A tab you chose is remembered on any row, and makes one where Jev has
		// none: a 'done' row with nothing of Jev's in it, so the email counts as
		// known (knownEmailIds) and is never sorted against your choice.
		correct: db.prepare(
			`INSERT INTO jev_decisions (account_id, email_id, status, backfill, corrected_to, created_at, decided_at)
			 VALUES (@accountId, @emailId, 'done', 0, @to, @now, @now)
			 ON CONFLICT (account_id, email_id) DO UPDATE SET corrected_to = excluded.corrected_to`
		),
		stats: db.prepare(
			`SELECT COUNT(*) AS sorted,
			        SUM(CASE WHEN corrected_to IS NOT NULL
			                  AND corrected_to IS NOT COALESCE(applied, 'important') THEN 1 ELSE 0 END) AS corrected
			 FROM jev_decisions
			 WHERE account_id = ? AND status = 'done' AND category IS NOT NULL AND decided_at >= ?`
		),
		addUsage: db.prepare(
			`INSERT INTO jev_usage (account_id, month, requests, input_tokens)
			 VALUES (?, ?, 1, ?)
			 ON CONFLICT (account_id, month) DO UPDATE SET
			   requests = requests + 1,
			   input_tokens = input_tokens + excluded.input_tokens`
		),
		usage: db.prepare(
			`SELECT requests, input_tokens FROM jev_usage WHERE account_id = ? AND month = ?`
		)
	};
}
function stmts() {
	return (_stmts ??= prepareStmts());
}

/**
 * Queue emails; returns how many were new to the queue. Emails already
 * known keep their row — an email Jev has answered for is never queued
 * twice. `backfill` marks mail that was already in the Inbox (see migration
 * 015) rather than newly arrived; it is queued a millisecond apart, so the
 * oldest-first queue keeps the order given.
 */
export function enqueueEmails(
	accountId: string,
	emailIds: string[],
	now = Date.now(),
	backfill = false
): number {
	const s = stmts();
	let added = 0;
	getDb().transaction(() => {
		emailIds.forEach((id, i) => {
			added += backfill
				? s.enqueueBackfill.run(accountId, id, now + i).changes
				: s.enqueue.run(accountId, id, 0, now).changes;
		});
	})();
	return added;
}

/** Oldest queued emails first: new arrivals, or (with `backfill`) existing mail. */
export function listPendingEmailIds(accountId: string, limit: number, backfill = false): string[] {
	return (stmts().pending.all(accountId, backfill ? 1 : 0, limit) as { email_id: string }[]).map(
		(r) => r.email_id
	);
}

export interface BackfillProgress {
	pending: number;
	done: number;
	failed: number;
	/** Left the Inbox first, or cancelled. */
	skipped: number;
}

export function backfillProgress(accountId: string): BackfillProgress {
	const out: BackfillProgress = { pending: 0, done: 0, failed: 0, skipped: 0 };
	for (const r of stmts().backfillProgress.all(accountId) as { status: keyof BackfillProgress; n: number }[]) {
		out[r.status] = r.n;
	}
	return out;
}

/** The emails among `emailIds` whose row satisfies `condition`, 500 ids a query. */
function emailIdsWhere(accountId: string, emailIds: string[], condition: string): Set<string> {
	const out = new Set<string>();
	const db = getDb();
	for (let i = 0; i < emailIds.length; i += 500) {
		const chunk = emailIds.slice(i, i + 500);
		const rows = db
			.prepare(
				`SELECT email_id FROM jev_decisions
				 WHERE account_id = ? AND (${condition})
				   AND email_id IN (${chunk.map(() => '?').join(',')})`
			)
			.all(accountId, ...chunk) as { email_id: string }[];
		for (const r of rows) out.add(r.email_id);
	}
	return out;
}

/**
 * Which of these emails Jev has judged or has queued, or you have put in a
 * tab yourself (recordCorrections). Skipped and failed mail is not known: it
 * was never sorted, so sorting existing mail offers it again. (Before this,
 * cancelling a run or switching Jev off and on marked the queue skipped, and
 * those emails could never be queued again.)
 */
export function knownEmailIds(accountId: string, emailIds: string[]): Set<string> {
	return emailIdsWhere(accountId, emailIds, `status IN ('pending', 'done') OR corrected_to IS NOT NULL`);
}

/** Which of these emails you have put in a tab yourself: Jev leaves their tab alone. */
export function correctedEmailIds(accountId: string, emailIds: string[]): Set<string> {
	return emailIdsWhere(accountId, emailIds, 'corrected_to IS NOT NULL');
}

/** Stop sorting existing mail: what is still queued is dropped. */
export function cancelBackfill(accountId: string, now = Date.now()): void {
	stmts().cancelBackfill.run(now, accountId);
}

/**
 * Withdraw everything still queued, new arrivals and existing mail alike.
 * Done whenever Jev is switched off or on, so mail queued before the
 * switch is never sent once it has moved.
 */
export function dropQueue(accountId: string, now = Date.now()): void {
	stmts().dropQueue.run(now, accountId);
}

export function recordDecision(
	accountId: string,
	emailId: string,
	d: {
		category: InboxCategory | null;
		confidence: number | null;
		applied: InboxCategory | null;
		answers: unknown;
		facts: unknown;
		/** The pin that decided the tab instead of Jev. */
		pinnedBy?: string | null;
		/** Null when there was nothing to ask, so Jev wasn't called. */
		model: string | null;
		inputTokens: number;
		/** Jev's spam verdict and what came of it, when spam checking was on. */
		spam?: { spam: number; phishing: number; stalwartSpam: boolean; action: string | null } | null;
	},
	now = Date.now()
): void {
	stmts().done.run({
		accountId,
		emailId,
		category: d.category,
		confidence: d.confidence,
		applied: d.applied,
		answers: JSON.stringify(d.answers),
		facts: JSON.stringify(d.facts),
		pinnedBy: d.pinnedBy ?? null,
		spam: d.spam?.spam ?? null,
		phishing: d.spam?.phishing ?? null,
		stalwartSpam: d.spam ? (d.spam.stalwartSpam ? 1 : 0) : null,
		spamAction: d.spam?.action ?? null,
		model: d.model,
		inputTokens: d.inputTokens,
		now
	});
}

/** The email left the Inbox (or vanished) before Jev was asked. */
export function markSkipped(accountId: string, emailId: string, now = Date.now()): void {
	stmts().skip.run(now, accountId, emailId);
}

/** Count a failed attempt; the email is given up on at MAX_JEV_ATTEMPTS. */
export function recordFailure(accountId: string, emailId: string, error: string, now = Date.now()): void {
	stmts().fail.run({ accountId, emailId, error: error.slice(0, 300), max: MAX_JEV_ATTEMPTS, now });
}

export function getDecision(accountId: string, emailId: string): JevDecisionRow | null {
	const row = stmts().get.get(accountId, emailId) as RawRow | undefined;
	return row ? toRow(row) : null;
}

/**
 * You moved emails to a tab. Where Jev had sorted them, that measures how
 * often it's wrong; wherever they were, it is your choice of tab — Important
 * included, which leaves no keyword to see it by — and Jev never sorts them
 * again (see correctedEmailIds and knownEmailIds).
 */
export function recordCorrections(accountId: string, emailIds: string[], to: InboxCategory, now = Date.now()): void {
	const s = stmts();
	getDb().transaction(() => {
		for (const id of emailIds) s.correct.run({ accountId, emailId: id, to, now });
	})();
}

/** You marked these Spam or Not spam: note it against Jev's verdict, where there was one. */
export function recordSpamCorrections(accountId: string, emailIds: string[], to: 'spam' | 'ham'): void {
	const s = stmts();
	getDb().transaction(() => {
		for (const id of emailIds) s.correctSpam.run(to, accountId, id);
	})();
}

export interface SpamRow {
	emailId: string;
	spam: number;
	phishing: number;
	stalwartSpam: boolean;
	action: string | null;
	correctedTo: 'spam' | 'ham' | null;
}

/** Every spam verdict since `sinceMs`, newest first. */
export function spamRows(accountId: string, sinceMs: number): SpamRow[] {
	return (
		stmts().spamRows.all(accountId, sinceMs) as {
			email_id: string;
			spam: number;
			phishing: number;
			stalwart_spam: number | null;
			spam_action: string | null;
			spam_corrected_to: string | null;
		}[]
	).map((r) => ({
		emailId: r.email_id,
		spam: r.spam,
		phishing: r.phishing,
		stalwartSpam: r.stalwart_spam === 1,
		action: r.spam_action,
		correctedTo: r.spam_corrected_to === 'spam' || r.spam_corrected_to === 'ham' ? r.spam_corrected_to : null
	}));
}

/** Emails Jev picked a tab for since `sinceMs`, and how many of those you moved elsewhere. */
export function decisionStats(accountId: string, sinceMs: number): { sorted: number; corrected: number } {
	const row = stmts().stats.get(accountId, sinceMs) as { sorted: number; corrected: number | null };
	return { sorted: row.sorted, corrected: row.corrected ?? 0 };
}

/** Calendar month key in UTC, e.g. `2026-10`. */
export function usageMonth(date = new Date()): string {
	return date.toISOString().slice(0, 7);
}

export function addUsage(accountId: string, inputTokens: number, date = new Date()): void {
	stmts().addUsage.run(accountId, usageMonth(date), inputTokens);
}

export function getUsage(accountId: string, month = usageMonth()): { requests: number; inputTokens: number } {
	const row = stmts().usage.get(accountId, month) as
		| { requests: number; input_tokens: number }
		| undefined;
	return { requests: row?.requests ?? 0, inputTokens: row?.input_tokens ?? 0 };
}
