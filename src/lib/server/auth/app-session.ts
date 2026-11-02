import { randomUUID } from 'node:crypto';
import { getDb } from '../db/index';

/**
 * DB-backed webmail sessions. Unlike the old in-memory map, these survive
 * container restarts — nobody gets logged out by a deploy, and background
 * schedulers no longer depend on a live login at all (they read
 * mail_accounts directly).
 *
 * Sliding expiration: every authenticated request inside the renewal
 * window pushes expires_at forward, capped at SESSION_TTL from last use.
 * The hook re-issues the cookie whenever that happens (`extended`), so its
 * Max-Age slides with the row. Expired rows go on the next sign-in, and
 * their push subscriptions with them (ON DELETE CASCADE).
 */

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const TOUCH_INTERVAL_MS = 60 * 1000; // don't write on every asset request

export interface AppSessionRow {
	id: string;
	user_id: string;
	created_at: string;
	last_seen_at: string;
	user_agent: string | null;
	ip: string | null;
	/** Last second-factor proof (SQLite UTC datetime), null if none yet. */
	verified_at?: string | null;
}

let _stmts: ReturnType<typeof prepareStmts> | null = null;
function prepareStmts() {
	const db = getDb();
	return {
		insert: db.prepare(
			`INSERT INTO app_sessions (id, user_id, expires_at, user_agent, ip, verified_at)
			 VALUES (?, ?, ?, ?, ?, CASE WHEN ? THEN datetime('now') END)`
		),
		get: db.prepare(
			`SELECT id, user_id, created_at, last_seen_at, user_agent, ip, expires_at, verified_at
			 FROM app_sessions WHERE id = ?`
		),
		verify: db.prepare(`UPDATE app_sessions SET verified_at = datetime('now') WHERE id = ?`),
		touch: db.prepare(
			`UPDATE app_sessions SET last_seen_at = datetime('now'), expires_at = ? WHERE id = ?`
		),
		del: db.prepare(`DELETE FROM app_sessions WHERE id = ?`),
		delForUser: db.prepare(`DELETE FROM app_sessions WHERE user_id = ? AND id != ?`),
		list: db.prepare(
			`SELECT id, user_id, created_at, last_seen_at, user_agent, ip
			 FROM app_sessions WHERE user_id = ? ORDER BY last_seen_at DESC`
		),
		prune: db.prepare(`DELETE FROM app_sessions WHERE expires_at < datetime('now')`)
	};
}
function stmts() {
	return (_stmts ??= prepareStmts());
}

function expiryFromNow(): string {
	return new Date(Date.now() + SESSION_TTL_MS).toISOString().replace('T', ' ').slice(0, 19);
}

/**
 * `verified` marks a sign-in that proved a second factor (a passkey, or a
 * code after the password), which also counts as a fresh re-check.
 */
export function createAppSession(
	userId: string,
	userAgent?: string,
	ip?: string,
	verified = false
): string {
	stmts().prune.run();
	const id = randomUUID();
	stmts().insert.run(id, userId, expiryFromNow(), userAgent ?? null, ip ?? null, verified ? 1 : 0);
	return id;
}

/** This session has just re-checked: a passkey, a code, or the password. */
export function markSessionVerified(id: string): void {
	stmts().verify.run(id);
}

/** `verified_at` as epoch ms, or null. */
export function verifiedAtMs(row: AppSessionRow): number | null {
	return row.verified_at ? new Date(row.verified_at + 'Z').getTime() : null;
}

/** `extended`: this read pushed expires_at forward, so the cookie should follow. */
export function getAppSession(id: string): (AppSessionRow & { extended: boolean }) | undefined {
	const row = stmts().get.get(id) as (AppSessionRow & { expires_at: string }) | undefined;
	if (!row) return undefined;
	if (new Date(row.expires_at + 'Z').getTime() < Date.now()) {
		stmts().del.run(id);
		return undefined;
	}
	// Slide the expiry forward, throttled so static-asset bursts stay cheap.
	const extended = Date.now() - new Date(row.last_seen_at + 'Z').getTime() > TOUCH_INTERVAL_MS;
	if (extended) stmts().touch.run(expiryFromNow(), id);
	return { ...row, extended };
}

export function deleteAppSession(id: string): void {
	stmts().del.run(id);
}

/** Sign out everywhere else — used after a password change. */
export function revokeOtherSessions(userId: string, keepId: string): void {
	stmts().delForUser.run(userId, keepId);
}

export function listSessions(userId: string): AppSessionRow[] {
	stmts().prune.run();
	return stmts().list.all(userId) as AppSessionRow[];
}
