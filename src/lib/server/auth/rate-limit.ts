import { createHash } from 'node:crypto';
import { getDb } from '../db/index';
import { logEvent } from '$lib/server/log';

/**
 * Fixed-window login rate limiting, persisted in SQLite so a container
 * restart doesn't reset an attacker's counter. 10 failures within a
 * 15-minute window locks the email+IP pair out for 15 minutes.
 *
 * Anyone can post the login form, so each row has to stay small and go
 * away again: the key is a hash, and rows whose window and lockout have
 * both run out are deleted on the next failure.
 */

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 10;
const LOCKOUT_MS = 15 * 60 * 1000;

let _stmts: ReturnType<typeof prepareStmts> | null = null;
function prepareStmts() {
	const db = getDb();
	return {
		get: db.prepare(`SELECT window_start, count, locked_until FROM login_attempts WHERE key = ?`),
		upsert: db.prepare(
			`INSERT INTO login_attempts (key, window_start, count, locked_until)
			 VALUES (@key, @windowStart, @count, @lockedUntil)
			 ON CONFLICT (key) DO UPDATE
			   SET window_start = @windowStart, count = @count, locked_until = @lockedUntil`
		),
		clear: db.prepare(`DELETE FROM login_attempts WHERE key = ?`),
		// ISO timestamps from toISOString() compare correctly as text.
		prune: db.prepare(
			`DELETE FROM login_attempts
			 WHERE window_start < ? AND (locked_until IS NULL OR locked_until < ?)`
		)
	};
}
function stmts() {
	return (_stmts ??= prepareStmts());
}

function keyFor(email: string, ip: string): string {
	return createHash('sha256').update(`${email.trim().toLowerCase()}|${ip}`).digest('hex');
}

/** True if this email+IP is currently locked out. */
export function isLockedOut(email: string, ip: string): boolean {
	const row = stmts().get.get(keyFor(email, ip)) as
		| { window_start: string; count: number; locked_until: string | null }
		| undefined;
	if (!row?.locked_until) return false;
	return new Date(row.locked_until).getTime() > Date.now();
}

/** Counts one failure; returns how many the window now holds. */
export function recordFailure(email: string, ip: string, maxFailures = MAX_FAILURES): number {
	const key = keyFor(email, ip);
	const now = Date.now();
	const row = stmts().get.get(key) as
		| { window_start: string; count: number; locked_until: string | null }
		| undefined;

	let windowStart = now;
	let count = 1;
	if (row && now - new Date(row.window_start).getTime() < WINDOW_MS) {
		windowStart = new Date(row.window_start).getTime();
		count = row.count + 1;
	}
	const lockedUntil = count >= maxFailures ? new Date(now + LOCKOUT_MS).toISOString() : null;
	stmts().prune.run(new Date(now - WINDOW_MS).toISOString(), new Date(now).toISOString());
	stmts().upsert.run({
		key,
		windowStart: new Date(windowStart).toISOString(),
		count,
		lockedUntil
	});
	return count;
}

export function recordSuccess(email: string, ip: string): void {
	stmts().clear.run(keyFor(email, ip));
}

// Every failure from one address counts here too, whatever email it tried,
// so trying a new email each time no longer resets the limit. Generous
// enough that a typo-prone owner never meets it.
const ANY_EMAIL = '\u0000any';
const MAX_IP_FAILURES = 30;

export function isIpLockedOut(ip: string): boolean {
	return isLockedOut(ANY_EMAIL, ip);
}

export function recordIpFailure(ip: string): void {
	if (recordFailure(ANY_EMAIL, ip, MAX_IP_FAILURES) !== MAX_IP_FAILURES || !isPrivateAddress(ip)) return;
	// Every client arriving as one private address means a reverse proxy in
	// front that isn't passing the real one on, so this lock holds everyone
	// out of the password form, the owner included. Say so where the operator
	// looks.
	const message =
		`${ip} is locked out after ${MAX_IP_FAILURES} failed sign-ins, and it is a private address: ` +
		`behind a reverse proxy, set ADDRESS_HEADER=X-Forwarded-For and XFF_DEPTH=1 so each client is counted on its own.`;
	console.warn(`[auth] ${message}`);
	logEvent('warn', 'auth', 'ip_lockout_behind_proxy', { ip, hint: 'ADDRESS_HEADER' });
}

/**
 * Loopback and private ranges: what every request's address is when a
 * reverse proxy in front hasn't been told to pass the client's own.
 */
export function isPrivateAddress(ip: string): boolean {
	const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
	if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v4)) {
		const [a, b] = v4.split('.').map(Number);
		return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
	}
	const lower = ip.toLowerCase();
	return lower === '::1' || /^f[cd][0-9a-f]{2}:/.test(lower) || lower.startsWith('fe80:');
}
