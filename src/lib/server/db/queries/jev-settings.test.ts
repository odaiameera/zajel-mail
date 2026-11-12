import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { beforeAll, describe, expect, it } from 'vitest';

// Point the lazy SQLite singleton at a throwaway file before anything opens it.
process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'ameera-jev-')), 'test.db');

import { getDb } from '../index';
import { runMigrations } from '../migrate';
import { getJevSettings, updateJevSettings } from './jev-settings';

function linkAccount(id: string) {
	getDb()
		.prepare(
			`INSERT INTO mail_accounts (id, user_id, email, server_url, jmap_account_id, secret_enc)
			 VALUES (?, 'user-1', ?, 'https://mail.example', 'jmap', 'x')`
		)
		.run(id, `${id}@example.test`);
}

beforeAll(() => {
	runMigrations();
	getDb()
		.prepare(`INSERT INTO app_user (id, email, password_hash) VALUES ('user-1', 'me@example.test', 'x')`)
		.run();
	linkAccount('acct-1');
	linkAccount('acct-2');
	linkAccount('acct-3');
});

describe('jev settings', () => {
	it('defaults to everything off for an account with no row', () => {
		expect(getJevSettings('acct-1')).toEqual({ inboxTabs: false, jevEnabled: false, jevSince: null, spamMode: 'off' });
	});

	it('keeps each account separate', () => {
		updateJevSettings('acct-1', { inboxTabs: true });
		expect(getJevSettings('acct-1').inboxTabs).toBe(true);
		expect(getJevSettings('acct-2').inboxTabs).toBe(false);

		updateJevSettings('acct-1', { inboxTabs: false });
		expect(getJevSettings('acct-1').inboxTabs).toBe(false);
	});

	it('starts sorting from the moment it is switched on, and forgets the cursor when off', () => {
		const on = new Date('2026-10-18T09:00:00Z');
		updateJevSettings('acct-3', { inboxTabs: true, jevEnabled: true }, on);
		expect(getJevSettings('acct-3')).toEqual({
			inboxTabs: true,
			jevEnabled: true,
			jevSince: on.toISOString(),
			spamMode: 'off'
		});

		// Saving it on again doesn't rewind the cursor.
		updateJevSettings('acct-3', { jevEnabled: true }, new Date('2026-10-18T10:00:00Z'));
		expect(getJevSettings('acct-3').jevSince).toBe(on.toISOString());

		updateJevSettings('acct-3', { jevEnabled: false });
		expect(getJevSettings('acct-3')).toMatchObject({ jevEnabled: false, jevSince: null });
	});

	it('keeps the spam mode', () => {
		updateJevSettings('acct-1', { spamMode: 'watch' });
		expect(getJevSettings('acct-1').spamMode).toBe('watch');
		updateJevSettings('acct-1', { inboxTabs: true });
		expect(getJevSettings('acct-1').spamMode).toBe('watch');
	});

	it('drops the row when the account is unlinked', () => {
		updateJevSettings('acct-2', { inboxTabs: true });
		getDb().prepare(`DELETE FROM mail_accounts WHERE id = 'acct-2'`).run();
		const row = getDb().prepare(`SELECT 1 FROM jev_settings WHERE account_id = 'acct-2'`).get();
		expect(row).toBeUndefined();
	});
});
