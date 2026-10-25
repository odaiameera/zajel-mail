import { getDb } from '../index';

export interface PushSubscriptionRow {
	endpoint: string;
	user_id: string;
	session_id: string;
	p256dh: string;
	auth: string;
	user_agent: string | null;
	created_at: string;
	last_sent_at: string | null;
}

let _stmts: ReturnType<typeof prepareStmts> | null = null;

function prepareStmts() {
	const db = getDb();
	return {
		// A browser that subscribes again (new keys, or now signed in as
		// someone else) replaces its old row.
		upsert: db.prepare(
			`INSERT INTO push_subscriptions (endpoint, user_id, session_id, p256dh, auth, user_agent)
			 VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT(endpoint) DO UPDATE SET
			   user_id = excluded.user_id, session_id = excluded.session_id,
			   p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent`
		),
		remove: db.prepare(`DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?`),
		removeEndpoint: db.prepare(`DELETE FROM push_subscriptions WHERE endpoint = ?`),
		removeAll: db.prepare(`DELETE FROM push_subscriptions`),
		listForUser: db.prepare(`SELECT * FROM push_subscriptions WHERE user_id = ?`),
		usersWithSubscriptions: db.prepare(`SELECT DISTINCT user_id FROM push_subscriptions`),
		markSent: db.prepare(
			`UPDATE push_subscriptions SET last_sent_at = datetime('now') WHERE endpoint = ?`
		),
		getVapid: db.prepare(`SELECT public_key, private_enc FROM push_vapid WHERE id = 1`),
		insertVapid: db.prepare(
			`INSERT OR IGNORE INTO push_vapid (id, public_key, private_enc) VALUES (1, ?, ?)`
		),
		replaceVapid: db.prepare(
			`INSERT OR REPLACE INTO push_vapid (id, public_key, private_enc) VALUES (1, ?, ?)`
		)
	};
}

function stmts() {
	if (!_stmts) _stmts = prepareStmts();
	return _stmts;
}

export function savePushSubscription(
	userId: string,
	sessionId: string,
	sub: { endpoint: string; p256dh: string; auth: string },
	userAgent: string | null
): void {
	stmts().upsert.run(sub.endpoint, userId, sessionId, sub.p256dh, sub.auth, userAgent);
}

export function deletePushSubscription(userId: string, endpoint: string): void {
	stmts().remove.run(endpoint, userId);
}

/** The push service says this subscription is gone (404/410). */
export function deleteExpiredSubscription(endpoint: string): void {
	stmts().removeEndpoint.run(endpoint);
}

/** For a new VAPID key pair, which no existing subscription can take. */
export function deleteEverySubscription(): void {
	stmts().removeAll.run();
}

export function listPushSubscriptions(userId: string): PushSubscriptionRow[] {
	return stmts().listForUser.all(userId) as PushSubscriptionRow[];
}

export function usersWithPushSubscriptions(): string[] {
	return (stmts().usersWithSubscriptions.all() as { user_id: string }[]).map((r) => r.user_id);
}

export function markPushSent(endpoint: string): void {
	stmts().markSent.run(endpoint);
}

export function getVapidRow(): { public_key: string; private_enc: string } | undefined {
	return stmts().getVapid.get() as { public_key: string; private_enc: string } | undefined;
}

/** Store a new pair unless one exists already; returns whichever is stored. */
export function insertVapidRow(publicKey: string, privateEnc: string): { public_key: string; private_enc: string } {
	stmts().insertVapid.run(publicKey, privateEnc);
	return getVapidRow()!;
}

export function replaceVapidRow(publicKey: string, privateEnc: string): void {
	stmts().replaceVapid.run(publicKey, privateEnc);
}
