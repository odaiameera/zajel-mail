import { getDb } from '../index';

/** Out-of-office replies sent. See migration 029_auto_reply.sql. */

let _stmts: ReturnType<typeof prepareStmts> | null = null;

// Rows are kept per mail account, but every question asked of them is per
// login (joined through mail_accounts.user_id): one message sent to two of
// the owner's addresses must get one reply, and the hourly cap is the
// login's, not each account's.
const OF_LOGIN = 'FROM auto_reply_log l JOIN mail_accounts a ON a.id = l.account_id WHERE a.user_id = ? AND l.sent_at > ?';

// Prepared lazily, as in the other query modules: preparing at module scope
// would open the database during `vite build`'s SSR pass.
function prepareStmts() {
	const db = getDb();
	return {
		insert: db.prepare('INSERT INTO auto_reply_log (account_id, sender, sent_at, email_id) VALUES (?, ?, ?, ?)'),
		remove: db.prepare('DELETE FROM auto_reply_log WHERE id = ?'),
		sendersSince: db.prepare(`SELECT DISTINCT l.sender ${OF_LOGIN}`),
		answeredSince: db.prepare(`SELECT 1 ${OF_LOGIN} AND l.sender = ? LIMIT 1`),
		countSince: db.prepare(`SELECT COUNT(*) AS n ${OF_LOGIN}`),
		prune: db.prepare('DELETE FROM auto_reply_log WHERE sent_at < ?')
	};
}
function stmts() {
	return (_stmts ??= prepareStmts());
}

/**
 * Record a reply about to be sent, unless the login already answered this
 * sender since `answeredAfter` or sent `cap` replies since `countAfter`.
 * The check and the insert are one transaction, so two runs (two of the
 * login's accounts, say) can't both claim the same sender. Returns the row
 * id, to remove it if the server refuses the reply, or null when the reply
 * must not be sent.
 */
export function claimAutoReply(row: {
	accountId: string;
	userId: string;
	sender: string;
	sentAt: string;
	emailId: string;
	answeredAfter: string;
	countAfter: string;
	cap: number;
}): number | null {
	const db = getDb();
	const s = stmts();
	return db.transaction(() => {
		if (s.answeredSince.get(row.userId, row.answeredAfter, row.sender)) return null;
		if ((s.countSince.get(row.userId, row.countAfter) as { n: number }).n >= row.cap) return null;
		return Number(s.insert.run(row.accountId, row.sender, row.sentAt, row.emailId).lastInsertRowid);
	})();
}

export function removeAutoReplyLog(id: number): void {
	stmts().remove.run(id);
}

/** The senders answered from any of this login's accounts after `sinceIso`. */
export function sendersAnsweredSince(userId: string, sinceIso: string): Set<string> {
	const rows = stmts().sendersSince.all(userId, sinceIso) as { sender: string }[];
	return new Set(rows.map((r) => r.sender));
}

/** How many replies this login's accounts sent after `sinceIso`. */
export function repliesSentSince(userId: string, sinceIso: string): number {
	return (stmts().countSince.get(userId, sinceIso) as { n: number }).n;
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
