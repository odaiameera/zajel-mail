import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { beforeAll, describe, expect, it } from 'vitest';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'zajel-user-')), 'test.db');

import { getDb } from '../db/index';
import { runMigrations } from '../db/migrate';
import { createAppUser, hasAppUser, verifyUserPassword } from './user';

beforeAll(() => {
	runMigrations();
});

describe('the master login', () => {
	it('is created once, however many setup submissions race for it', async () => {
		expect(hasAppUser()).toBe(false);
		// Both pass hasAppUser() and spend a password hash before either inserts.
		const [first, second] = await Promise.all([
			createAppUser('Owner@Example.test', 'password-one'),
			createAppUser('intruder@example.test', 'password-two')
		]);
		const winners = [first, second].filter(Boolean);
		expect(winners).toHaveLength(1);
		expect((getDb().prepare('SELECT COUNT(*) AS n FROM app_user').get() as { n: number }).n).toBe(1);
		expect(hasAppUser()).toBe(true);

		// And it signs in with the password it was given, email case aside.
		const winner = winners[0]!;
		const password = winner.email === 'owner@example.test' ? 'password-one' : 'password-two';
		expect(await verifyUserPassword(winner.email.toUpperCase(), password)).toEqual(winner);
		expect(await createAppUser('late@example.test', 'password-three')).toBeUndefined();
	}, 30_000);
});
