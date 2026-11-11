import { mkdtempSync, readdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { beforeAll, describe, expect, it, vi } from 'vitest';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'zajel-migration-032-')), 'test.db');
vi.mock('$lib/server/log', () => ({ logEvent: vi.fn(), errorFields: (e: unknown) => ({ error: String(e) }) }));
vi.mock('$env/dynamic/private', () => ({ env: {} }));

import { getDb } from '$lib/server/db/index';
import { runMigrations } from '$lib/server/db/migrate';
import { getJevSettings } from '$lib/server/db/queries/jev-settings';
import { getCursor } from './arrivals';

const DIR = fileURLToPath(new URL('../db/migrations/', import.meta.url));
/** The migrations, as runMigrations takes them, up to but not including `before`. */
function migrationsBefore(before: string): Record<string, string> {
	return Object.fromEntries(
		readdirSync(DIR)
			.filter((f) => f.endsWith('.sql') && f < before)
			.map((f) => [`./migrations/${f}`, readFileSync(join(DIR, f), 'utf8')])
	);
}

beforeAll(() => {
	// The database as it was before 032: the rules scheduler's place by
	// address, and Jev's by account.
	runMigrations(migrationsBefore('032'));
	getDb().exec(`
		INSERT INTO app_user (id, email, password_hash) VALUES ('u1', 'u1@example.test', 'x');
		INSERT INTO mail_accounts (id, user_id, email, server_url, jmap_account_id, secret_enc) VALUES
			('both', 'u1', 'both@example.test', 'https://mail.example', 'j1', 'x'),
			('jev-earlier', 'u1', 'jev@example.test', 'https://mail.example', 'j2', 'x'),
			('rules-only', 'u1', 'rules@example.test', 'https://mail.example', 'j3', 'x'),
			('jev-only', 'u1', 'jevonly@example.test', 'https://mail.example', 'j4', 'x'),
			('none', 'u1', 'none@example.test', 'https://mail.example', 'j5', 'x'),
			('case', 'u1', 'Case@Example.test', 'https://mail.example', 'j6', 'x'),
			('exact', 'u1', 'dup@example.test', 'https://mail.example', 'j7', 'x');

		INSERT INTO rules_cursor (user_email, last_run) VALUES
			('both@example.test', '2026-10-20T07:00:04.000Z'),
			-- Half a second after Jev's, written with milliseconds: as text it sorts first.
			('jev@example.test', '2026-10-20T07:00:00.500Z'),
			('rules@example.test', '2026-10-20T06:00:00.000Z'),
			-- Another spelling of an account's address, and no row with its exact one.
			('case@example.test', '2026-10-20T05:00:00.000Z'),
			-- An exact row, and another spelling that is earlier: only the exact one is the account's.
			('dup@example.test', '2026-10-20T08:00:00.000Z'),
			('DUP@example.test', '2026-10-20T01:00:00.000Z'),
			-- An address with no account.
			('gone@example.test', '2026-10-20T02:00:00.000Z');

		INSERT INTO jev_settings (account_id, inbox_tabs, jev_enabled, sort_cursor, updated_at) VALUES
			('both', 1, 1, '2026-10-20T07:00:05Z', 0),
			('jev-earlier', 1, 1, '2026-10-20T07:00:00Z', 0),
			('jev-only', 1, 1, '2026-10-20T07:30:00Z', 0),
			('none', 1, 0, NULL, 0);
	`);
	runMigrations();
});

describe('migration 032', () => {
	it('starts each account from the earlier of its two old places, compared as times', () => {
		expect(getCursor('both')).toBe('2026-10-20T07:00:04.000Z');
		expect(getCursor('jev-earlier')).toBe('2026-10-20T07:00:00Z');
	});

	it('starts from the one place an account had', () => {
		expect(getCursor('rules-only')).toBe('2026-10-20T06:00:00.000Z');
		expect(getCursor('jev-only')).toBe('2026-10-20T07:30:00Z');
	});

	it('gives an account with neither no place, so its first pass starts from then', () => {
		expect(getDb().prepare(`SELECT 1 FROM mail_pipeline WHERE account_id = 'none'`).get()).toBeUndefined();
		expect(getCursor('none')).toBeNull();
	});

	it('matches the rules’ place to its account without regard to case only where no row has the exact address', () => {
		expect(getCursor('case')).toBe('2026-10-20T05:00:00.000Z');
		expect(getCursor('exact')).toBe('2026-10-20T08:00:00.000Z');
	});

	it('keeps Jev’s own place as when Jev was switched on', () => {
		expect(getJevSettings('both').jevSince).toBe('2026-10-20T07:00:05Z');
		expect(getJevSettings('jev-only').jevSince).toBe('2026-10-20T07:30:00Z');
		expect(getJevSettings('none').jevSince).toBeNull();
		const columns = (getDb().prepare('PRAGMA table_info(jev_settings)').all() as { name: string }[]).map((c) => c.name);
		expect(columns).toContain('jev_since');
		expect(columns).not.toContain('sort_cursor');
	});

	it('forgets an account’s place and its arrivals when the account is removed', () => {
		const db = getDb();
		db.prepare(
			`INSERT INTO mail_arrivals (account_id, email_id, mailbox, received_at, seen_at) VALUES ('both', 'm1', 'inbox', '2026-10-20T07:01:00Z', 0)`
		).run();
		db.prepare(`DELETE FROM mail_accounts WHERE id = 'both'`).run();
		expect(db.prepare(`SELECT 1 FROM mail_pipeline WHERE account_id = 'both'`).get()).toBeUndefined();
		expect(db.prepare(`SELECT 1 FROM mail_arrivals WHERE account_id = 'both'`).get()).toBeUndefined();
	});
});
