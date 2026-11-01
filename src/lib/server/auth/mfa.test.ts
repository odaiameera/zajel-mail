import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Point the lazy SQLite singleton at a throwaway file before anything opens it.
process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'ameera-mfa-')), 'test.db');
vi.mock('$env/dynamic/private', () => ({ env: { WEBMAIL_SECRET: 'test-secret-test-secret-test-secret-123' } }));

import { getDb } from '../db/index';
import { runMigrations } from '../db/migrate';
import {
	beginTotp,
	confirmTotp,
	createMfaChallenge,
	disableTotp,
	hasSecondFactor,
	pendingMfaUser,
	recoveryCodesLeft,
	regenerateRecoveryCodes,
	takeMfaAttempt,
	totpEnabled,
	verifySecondFactorCode
} from './mfa';
import { insertPasskey } from './passkeys';
import { timeStep, totpCode } from './totp';

const USER = 'user-1';
const T0 = Date.UTC(2026, 10, 1, 9, 0, 0);
const codeAt = (secret: string, ms: number) => totpCode(secret, timeStep(ms));

beforeAll(() => {
	runMigrations();
	getDb().prepare(`INSERT INTO app_user (id, email, password_hash) VALUES (?, 'me@example.test', 'x')`).run(USER);
});

beforeEach(() => {
	disableTotp(USER);
	getDb().prepare('DELETE FROM passkeys').run();
	getDb().prepare('DELETE FROM mfa_challenges').run();
});

describe('authenticator app', () => {
	it('is not in force until a first code matches, then hands out recovery codes', () => {
		const secret = beginTotp(USER)!;
		expect(totpEnabled(USER)).toBe(false);
		expect(hasSecondFactor(USER)).toBe(false);
		expect(confirmTotp(USER, '000000', T0)).toBeNull();

		const codes = confirmTotp(USER, codeAt(secret, T0), T0)!;
		expect(codes).toHaveLength(10);
		expect(codes[0]).toMatch(/^[a-z2-7]{5}-[a-z2-7]{5}$/);
		expect(totpEnabled(USER)).toBe(true);
		expect(hasSecondFactor(USER)).toBe(true);
		expect(recoveryCodesLeft(USER)).toBe(10);
		// Can't be swapped for another secret while in force.
		expect(beginTotp(USER)).toBeNull();
	});

	it('accepts each code once, so a seen code cannot be replayed', () => {
		const secret = beginTotp(USER)!;
		confirmTotp(USER, codeAt(secret, T0), T0);
		// The confirming code itself is spent.
		expect(verifySecondFactorCode(USER, codeAt(secret, T0), T0)).toBeNull();

		const later = T0 + 60_000;
		expect(verifySecondFactorCode(USER, codeAt(secret, later), later)).toBe('totp');
		expect(verifySecondFactorCode(USER, codeAt(secret, later), later)).toBeNull();
		expect(verifySecondFactorCode(USER, '123 456', later)).toBeNull();
	});

	it('spends a recovery code on use, and new codes replace the old', () => {
		const secret = beginTotp(USER)!;
		const [first, second] = confirmTotp(USER, codeAt(secret, T0), T0)!;
		expect(verifySecondFactorCode(USER, first.toUpperCase().replace('-', ' '), T0)).toBe('recovery');
		expect(verifySecondFactorCode(USER, first, T0)).toBeNull();
		expect(recoveryCodesLeft(USER)).toBe(9);

		const fresh = regenerateRecoveryCodes(USER)!;
		expect(verifySecondFactorCode(USER, second, T0)).toBeNull();
		expect(verifySecondFactorCode(USER, fresh[0], T0)).toBe('recovery');
	});

	it('turning it off removes the secret and the recovery codes', () => {
		const secret = beginTotp(USER)!;
		const [code] = confirmTotp(USER, codeAt(secret, T0), T0)!;
		disableTotp(USER);
		expect(totpEnabled(USER)).toBe(false);
		expect(verifySecondFactorCode(USER, code, T0)).toBeNull();
		expect(recoveryCodesLeft(USER)).toBe(0);
	});

	it('stores the secret encrypted', () => {
		const secret = beginTotp(USER)!;
		const row = getDb().prepare('SELECT secret_enc FROM user_totp WHERE user_id = ?').get(USER) as { secret_enc: string };
		expect(row.secret_enc).not.toContain(secret);
	});
});

describe('second factors', () => {
	it('counts a passkey as one by itself', () => {
		insertPasskey({ id: 'pk1', userId: USER, publicKey: 'x', counter: 0, transports: undefined, name: 'Mac' });
		expect(hasSecondFactor(USER)).toBe(true);
		expect(totpEnabled(USER)).toBe(false);
	});
});

describe('sign-in challenge', () => {
	it('allows five attempts, then has to start again', () => {
		const id = createMfaChallenge(USER, T0);
		expect(pendingMfaUser(id, T0)).toBe(USER);
		for (let i = 0; i < 5; i++) expect(takeMfaAttempt(id, T0)).toBe(USER);
		expect(takeMfaAttempt(id, T0)).toBeNull();
		expect(pendingMfaUser(id, T0)).toBeNull();
	});

	it('expires after five minutes', () => {
		const id = createMfaChallenge(USER, Date.now());
		expect(takeMfaAttempt(id, Date.now() + 6 * 60_000)).toBeNull();
	});
});
