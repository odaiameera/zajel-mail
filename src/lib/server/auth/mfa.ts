import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { getDb } from '../db/index';
import { decryptSecret, encryptSecret } from './crypto';
import { listPasskeys } from './passkeys';
import { base32Encode, generateTotpSecret, matchTotp } from './totp';

/**
 * Second factors for the master login: an authenticator app with one-time
 * recovery codes, or a passkey. Also the short-lived challenge that sits
 * between a correct password and the second step of sign-in.
 */

const RECOVERY_CODE_COUNT = 10;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const MAX_CHALLENGE_ATTEMPTS = 5;

let _stmts: ReturnType<typeof prepareStmts> | null = null;
function prepareStmts() {
	const db = getDb();
	return {
		totpGet: db.prepare(`SELECT secret_enc, confirmed_at, last_step FROM user_totp WHERE user_id = ?`),
		totpUpsert: db.prepare(
			`INSERT INTO user_totp (user_id, secret_enc) VALUES (?, ?)
			 ON CONFLICT (user_id) DO UPDATE SET secret_enc = excluded.secret_enc,
			   confirmed_at = NULL, last_step = 0, created_at = datetime('now')`
		),
		totpConfirm: db.prepare(
			`UPDATE user_totp SET confirmed_at = datetime('now'), last_step = ? WHERE user_id = ?`
		),
		totpStep: db.prepare(`UPDATE user_totp SET last_step = ? WHERE user_id = ? AND last_step < ?`),
		totpDelete: db.prepare(`DELETE FROM user_totp WHERE user_id = ?`),
		codesDelete: db.prepare(`DELETE FROM recovery_codes WHERE user_id = ?`),
		codeInsert: db.prepare(`INSERT INTO recovery_codes (user_id, code_hash) VALUES (?, ?)`),
		codeUse: db.prepare(
			`UPDATE recovery_codes SET used_at = datetime('now')
			 WHERE user_id = ? AND code_hash = ? AND used_at IS NULL`
		),
		codesLeft: db.prepare(`SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL`),
		challengeInsert: db.prepare(`INSERT INTO mfa_challenges (id, user_id, expires_at) VALUES (?, ?, ?)`),
		challengeGet: db.prepare(`SELECT user_id, expires_at, attempts FROM mfa_challenges WHERE id = ?`),
		challengeAttempt: db.prepare(`UPDATE mfa_challenges SET attempts = attempts + 1 WHERE id = ?`),
		challengeDelete: db.prepare(`DELETE FROM mfa_challenges WHERE id = ?`),
		challengePrune: db.prepare(`DELETE FROM mfa_challenges WHERE expires_at < ?`)
	};
}
function stmts() {
	return (_stmts ??= prepareStmts());
}

interface TotpRow {
	secret_enc: string;
	confirmed_at: string | null;
	last_step: number;
}

export function totpEnabled(userId: string): boolean {
	return !!(stmts().totpGet.get(userId) as TotpRow | undefined)?.confirmed_at;
}

/** Any second factor at all: an authenticator app or a passkey. */
export function hasSecondFactor(userId: string): boolean {
	return totpEnabled(userId) || listPasskeys(userId).length > 0;
}

export function recoveryCodesLeft(userId: string): number {
	return (stmts().codesLeft.get(userId) as { n: number }).n;
}

/**
 * Start setting up an authenticator app: a new secret, not yet in force.
 * Refused while one is already confirmed; that one has to be turned off
 * first, so a stolen session can't quietly swap in its own.
 */
export function beginTotp(userId: string): string | null {
	if (totpEnabled(userId)) return null;
	const secret = generateTotpSecret();
	stmts().totpUpsert.run(userId, encryptSecret(secret));
	return secret;
}

/**
 * Put the pending secret in force once a code from the app matches it, and
 * hand out a fresh set of recovery codes, shown this once.
 */
export function confirmTotp(userId: string, code: string, nowMs = Date.now()): string[] | null {
	const row = stmts().totpGet.get(userId) as TotpRow | undefined;
	if (!row || row.confirmed_at) return null;
	const step = matchTotp(decryptSecret(row.secret_enc), code, nowMs);
	if (step === null) return null;
	let codes: string[] = [];
	getDb().transaction(() => {
		stmts().totpConfirm.run(step, userId);
		codes = replaceRecoveryCodes(userId);
	})();
	return codes;
}

export function disableTotp(userId: string): void {
	getDb().transaction(() => {
		stmts().totpDelete.run(userId);
		stmts().codesDelete.run(userId);
	})();
}

export function regenerateRecoveryCodes(userId: string): string[] | null {
	if (!totpEnabled(userId)) return null;
	let codes: string[] = [];
	getDb().transaction(() => {
		codes = replaceRecoveryCodes(userId);
	})();
	return codes;
}

function replaceRecoveryCodes(userId: string): string[] {
	stmts().codesDelete.run(userId);
	const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => {
		const raw = base32Encode(randomBytes(7)).slice(0, 10).toLowerCase();
		return `${raw.slice(0, 5)}-${raw.slice(5)}`;
	});
	for (const code of codes) stmts().codeInsert.run(userId, hashRecoveryCode(code));
	return codes;
}

function hashRecoveryCode(code: string): string {
	return createHash('sha256').update(code.toLowerCase().replace(/[\s-]/g, '')).digest('hex');
}

/**
 * Check a second-factor code: six digits from the authenticator app, or an
 * unused recovery code (which is then spent). Returns which one matched.
 */
export function verifySecondFactorCode(
	userId: string,
	input: string,
	nowMs = Date.now()
): 'totp' | 'recovery' | null {
	const code = input.trim();
	const row = stmts().totpGet.get(userId) as TotpRow | undefined;
	if (!row?.confirmed_at) return null;

	if (/^\d{3}\s?\d{3}$/.test(code)) {
		const step = matchTotp(decryptSecret(row.secret_enc), code, nowMs, row.last_step);
		if (step === null) return null;
		// Guarded on last_step, so two requests racing with the same code
		// can't both win.
		return stmts().totpStep.run(step, userId, step).changes === 1 ? 'totp' : null;
	}
	if (/^[a-z2-7]{10}$/i.test(code.replace(/[\s-]/g, ''))) {
		return stmts().codeUse.run(userId, hashRecoveryCode(code)).changes === 1 ? 'recovery' : null;
	}
	return null;
}

// --- Sign-in challenge --------------------------------------------------------

function sqlTime(ms: number): string {
	return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

export function createMfaChallenge(userId: string, nowMs = Date.now()): string {
	stmts().challengePrune.run(sqlTime(nowMs));
	const id = randomUUID();
	stmts().challengeInsert.run(id, userId, sqlTime(nowMs + CHALLENGE_TTL_MS));
	return id;
}

/** The user a pending challenge is for, without counting an attempt. */
export function pendingMfaUser(id: string, nowMs = Date.now()): string | null {
	const row = stmts().challengeGet.get(id) as
		| { user_id: string; expires_at: string; attempts: number }
		| undefined;
	if (!row || row.attempts >= MAX_CHALLENGE_ATTEMPTS) return null;
	return new Date(row.expires_at + 'Z').getTime() < nowMs ? null : row.user_id;
}

/**
 * The user a pending challenge is for, counting this as one attempt. Null
 * once it has expired or seen too many wrong codes; it is then removed.
 */
export function takeMfaAttempt(id: string, nowMs = Date.now()): string | null {
	const row = stmts().challengeGet.get(id) as
		| { user_id: string; expires_at: string; attempts: number }
		| undefined;
	if (!row) return null;
	const expired = new Date(row.expires_at + 'Z').getTime() < nowMs;
	if (expired || row.attempts >= MAX_CHALLENGE_ATTEMPTS) {
		stmts().challengeDelete.run(id);
		return null;
	}
	stmts().challengeAttempt.run(id);
	return row.user_id;
}

export function deleteMfaChallenge(id: string): void {
	stmts().challengeDelete.run(id);
}
