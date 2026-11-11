import { mkdtempSync, readdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { beforeAll, describe, expect, it, vi } from 'vitest';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'zajel-mailbox-meta-')), 'test.db');
vi.mock('$lib/server/log', () => ({ logEvent: vi.fn(), errorFields: (e: unknown) => ({ error: String(e) }) }));

import { getDb } from '../index';
import { runMigrations } from '../migrate';
import { deleteMailboxMeta, getMailboxMeta, listMailboxMeta, setMailboxMeta } from './mailbox-meta';

const DIR = fileURLToPath(new URL('../migrations/', import.meta.url));
/** The migrations, as runMigrations takes them, up to but not including `before`. */
function migrationsBefore(before: string): Record<string, string> {
	return Object.fromEntries(
		readdirSync(DIR)
			.filter((f) => f.endsWith('.sql') && f < before)
			.map((f) => [`./migrations/${f}`, readFileSync(join(DIR, f), 'utf8')])
	);
}

beforeAll(() => {
	// The database as it was before 031, with metadata in the two old tables.
	runMigrations(migrationsBefore('031'));
	const db = getDb();
	db.exec(`
		INSERT INTO app_user (id, email, password_hash) VALUES ('u1', 'u1@example.test', 'x');
		INSERT INTO mail_accounts (id, user_id, email, server_url, jmap_account_id, secret_enc) VALUES
			('acct-me', 'u1', 'me@example.test', 'https://mail.example', 'j1', 'x'),
			('acct-mixed', 'u1', 'Mixed@Example.test', 'https://mail.example', 'j2', 'x'),
			-- Differs from the first only in case: it gets none of the first's rows.
			('acct-upper', 'u1', 'ME@example.test', 'https://mail.example', 'j3', 'x');

		-- A label and a folder of the first account, matched exactly.
		INSERT INTO label_meta (user_email, mailbox_id, display_name, color, icon, updated_at)
			VALUES ('me@example.test', 'L1', 'Work', '#ff0000', 'star', '2026-01-01 10:00:00');
		INSERT INTO folder_meta (user_email, mailbox_id, display_name, color, icon, updated_at)
			VALUES ('me@example.test', 'F1', 'Bills', '#00ff00', '', '2026-01-01 10:00:00');

		-- An address written in a different case from the account's.
		INSERT INTO label_meta (user_email, mailbox_id, display_name, color, icon)
			VALUES ('mixed@example.test', 'L2', 'Home', '#0000ff', NULL);

		-- An address with no account at all.
		INSERT INTO folder_meta (user_email, mailbox_id, display_name, color, icon)
			VALUES ('gone@example.test', 'F9', 'Old', '#123456', NULL);

		-- The same mailbox id in both tables: the one changed last wins.
		INSERT INTO label_meta (user_email, mailbox_id, display_name, color, icon, updated_at)
			VALUES ('me@example.test', 'BOTH', 'As a label', '#111111', NULL, '2026-01-01 10:00:00');
		INSERT INTO folder_meta (user_email, mailbox_id, display_name, color, icon, updated_at)
			VALUES ('me@example.test', 'BOTH', 'As a folder', '#222222', 'folder-heart', '2026-02-01 10:00:00');
		INSERT INTO label_meta (user_email, mailbox_id, display_name, color, icon, updated_at)
			VALUES ('me@example.test', 'BOTH2', 'Label, newer', '#333333', NULL, '2026-03-01 10:00:00');
		INSERT INTO folder_meta (user_email, mailbox_id, display_name, color, icon, updated_at)
			VALUES ('me@example.test', 'BOTH2', 'Folder, older', '#444444', NULL, '2026-02-01 10:00:00');
	`);
	runMigrations();
});

describe('migration 031', () => {
	it('copies label and folder rows to their account, an empty icon becoming none', () => {
		expect(getMailboxMeta('acct-me', 'L1')).toEqual({ mailboxId: 'L1', color: '#ff0000', icon: 'star', displayName: 'Work' });
		expect(getMailboxMeta('acct-me', 'F1')).toEqual({ mailboxId: 'F1', color: '#00ff00', icon: null, displayName: 'Bills' });
	});

	it('matches an address in another case only when no account has it exactly', () => {
		expect(getMailboxMeta('acct-mixed', 'L2')).toMatchObject({ color: '#0000ff' });
		expect(listMailboxMeta('acct-upper')).toEqual([]);
	});

	it('leaves behind rows whose address has no account, and the old tables as they were', () => {
		const all = getDb().prepare('SELECT mailbox_id FROM mailbox_meta ORDER BY mailbox_id').all() as { mailbox_id: string }[];
		expect(all.map((r) => r.mailbox_id)).toEqual(['BOTH', 'BOTH2', 'F1', 'L1', 'L2']);
		expect((getDb().prepare('SELECT COUNT(*) AS n FROM folder_meta').get() as { n: number }).n).toBe(4);
		expect((getDb().prepare('SELECT COUNT(*) AS n FROM label_meta').get() as { n: number }).n).toBe(4);
	});

	it('keeps the row changed last when both tables have the same mailbox', () => {
		expect(getMailboxMeta('acct-me', 'BOTH')).toEqual({ mailboxId: 'BOTH', color: '#222222', icon: 'folder-heart', displayName: 'As a folder' });
		expect(getMailboxMeta('acct-me', 'BOTH2')).toMatchObject({ color: '#333333', displayName: 'Label, newer' });
	});
});

describe('the mailbox_meta store', () => {
	it('changes only what it is given, and clears a value set to null', () => {
		expect(setMailboxMeta('acct-me', 'L1', { color: null })).toEqual({ mailboxId: 'L1', color: null, icon: 'star', displayName: 'Work' });
		expect(getMailboxMeta('acct-me', 'L1')?.color).toBeNull();
		setMailboxMeta('acct-me', 'L1', { icon: 'inbox' });
		expect(getMailboxMeta('acct-me', 'L1')).toEqual({ mailboxId: 'L1', color: null, icon: 'inbox', displayName: 'Work' });
	});

	it('removes a row once nothing is left in it', () => {
		setMailboxMeta('acct-me', 'NEW', { color: '#abcdef' });
		expect(setMailboxMeta('acct-me', 'NEW', { color: null })).toBeNull();
		expect(getMailboxMeta('acct-me', 'NEW')).toBeNull();
	});

	it('keeps each account’s rows apart', () => {
		setMailboxMeta('acct-mixed', 'L1', { color: '#999999' });
		expect(getMailboxMeta('acct-me', 'L1')?.color).toBeNull();
		deleteMailboxMeta('acct-mixed', 'L1');
		expect(listMailboxMeta('acct-mixed').map((r) => r.mailboxId)).toEqual(['L2']);
	});

	it('goes with the account', () => {
		getDb().prepare(`DELETE FROM mail_accounts WHERE id = 'acct-mixed'`).run();
		expect(listMailboxMeta('acct-mixed')).toEqual([]);
	});
});
