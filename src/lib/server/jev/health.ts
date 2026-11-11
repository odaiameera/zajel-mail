import { logEvent } from '$lib/server/log';

/**
 * How TypeSafe has been doing for each account, kept in memory: a pause
 * after it rate-limited every call of a pass, whether its last pass found
 * it down, and which failures were last logged, so a failing pass is
 * logged when it starts failing (or fails differently) and once when it
 * recovers, not every minute in between.
 */

/** How long an account's queue waits after TypeSafe rate-limited every call of a pass. */
export const RATE_LIMIT_PAUSE_MS = 5 * 60_000;

// Accounts TypeSafe rate-limited on a recent pass, and until when they wait.
const rateLimitedUntil = new Map<string, number>();

// Accounts whose last pass found TypeSafe down or rate-limiting: until a
// scheduled pass gets through, a change to their mail doesn't call again.
const typesafeFailing = new Set<string>();

// The failure last logged, per kind and account.
const lastFailure = new Map<string, string>();

/** Forget the rate-limit pauses and the failures logged — for tests, which run many passes on one account. */
export function forgetRateLimits(): void {
	rateLimitedUntil.clear();
	typesafeFailing.clear();
	lastFailure.clear();
}

/** Whether TypeSafe asked this account's queue to wait, at `now` (ms). */
export function rateLimitPaused(accountRowId: string, now: number): boolean {
	return (rateLimitedUntil.get(accountRowId) ?? 0) > now;
}

/** TypeSafe rate-limited every call: pause the account's queue for a while. */
export function pauseForRateLimit(accountRowId: string, now: number): void {
	rateLimitedUntil.set(accountRowId, now + RATE_LIMIT_PAUSE_MS);
	typesafeFailing.add(accountRowId);
}

/** TypeSafe was down for every call of a pass. */
export function markTypesafeFailing(accountRowId: string): void {
	typesafeFailing.add(accountRowId);
}

/** Whether the account's last pass found TypeSafe failing. */
export function typesafeFailingFor(accountRowId: string): boolean {
	return typesafeFailing.has(accountRowId);
}

/** A scheduled pass tries TypeSafe again; if it still fails, it says so. */
export function retryTypesafe(accountRowId: string): void {
	typesafeFailing.delete(accountRowId);
}

/** Log a failure of this kind for the account, unless it is the one logged last. `area` is the log's (Jev's, or the pipeline's). */
export function noteFailure(kind: string, accountRowId: string, event: string, fields: Record<string, unknown>, area = 'jev'): void {
	const key = `${kind}:${accountRowId}`;
	const text = `${event}:${String(fields.error)}`;
	if (lastFailure.get(key) === text) return;
	lastFailure.set(key, text);
	logEvent('error', area, event, { account: accountRowId, ...fields });
}

/** Log that a failure of this kind has stopped, if one was logged. */
export function noteRecovered(kind: string, accountRowId: string, event: string, area = 'jev'): void {
	if (lastFailure.delete(`${kind}:${accountRowId}`)) logEvent('info', area, event, { account: accountRowId });
}
