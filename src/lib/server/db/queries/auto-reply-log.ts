import { getDb } from '../index';

/** Out-of-office replies sent. See migration 029_auto_reply.sql. */

let _stmts: ReturnType<typeof prepareStmts> | null = null;

// Prepared lazily, as in the other query modules: preparing at module scope
// would open the database during `vite build`'s SSR pass.
function prepareStmts() {
	const db = getDb();
	return {
		insert: db.prepare('INSERT INTO auto_reply_log (account_id, sender, sent_at, email_id) VALUES (?, ?, ?, ?)'),
		remove: db.prepare('DELETE FROM auto_reply_log WHERE id = ?'),
		sendersSince: db.prepare('SELECT DISTINCT sender FROM auto_reply_log WHERE account_id = ? AND sent_at > ?'),
		countSince: db.prepare('SELECT COUNT(*) AS n FROM auto_reply_log WHERE account_id = ? AND sent_at > ?'),
		prune: db.prepare('DELETE FROM auto_reply_log WHERE sent_at < ?')
	};
}
function stmts() {
	return (_stmts ??= prepareStmts());
}

/** Record a reply about to be sent; returns the row id, to remove it if the send fails. */
export function insertAutoReplyLog(accountId: string, sender: string, sentAt: string, emailId: string): number {
	return Number(stmts().insert.run(accountId, sender, sentAt, emailId).lastInsertRowid);
}

export function removeAutoReplyLog(id: number): void {
	stmts().remove.run(id);
}

/** The senders answered from this account after `sinceIso`. */
export function sendersAnsweredSince(accountId: string, sinceIso: string): Set<string> {
	const rows = stmts().sendersSince.all(accountId, sinceIso) as { sender: string }[];
	return new Set(rows.map((r) => r.sender));
}

/** How many replies this account sent after `sinceIso`. */
export function repliesSentSince(accountId: string, sinceIso: string): number {
	return (stmts().countSince.get(accountId, sinceIso) as { n: number }).n;
}

/** The latest replies from any of these accounts, newest first. */
export function recentAutoReplies(
	accountIds: string[],
	limit: number
): { sender: string; sent_at: string; account_id: string }[] {
	if (accountIds.length === 0) return [];
	const marks = accountIds.map(() => '?').join(', ');
	return getDb()
		.prepare(
			`SELECT sender, sent_at, account_id FROM auto_reply_log WHERE account_id IN (${marks})
			 ORDER BY sent_at DESC, id DESC LIMIT ?`
		)
		.all(...accountIds, limit) as { sender: string; sent_at: string; account_id: string }[];
}

/** Drop rows sent before `beforeIso`. */
export function pruneAutoReplyLog(beforeIso: string): void {
	stmts().prune.run(beforeIso);
}
