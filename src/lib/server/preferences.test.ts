import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { beforeAll, describe, expect, it } from 'vitest';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'zajel-prefs-')), 'test.db');

import { getDb } from './db/index';
import { runMigrations } from './db/migrate';
import { getPrefs } from './db/queries/app-prefs';
import { exportPreferences, importPreferences } from './preferences';

beforeAll(() => {
	runMigrations();
	getDb().prepare(`INSERT INTO app_user (id, email, password_hash) VALUES ('u1', 'u1@example.test', 'x')`).run();
});

describe('preference export and import', () => {
	it('round-trips the page size with the other preferences, and drops what it does not know', () => {
		importPreferences('u1', { theme: 'light', defaultPageSize: '25', mail_rules: '[]', bogus: 'x', density: 7 });
		expect(getPrefs('u1')).toEqual({ theme: 'light', defaultPageSize: '25' });
		expect(exportPreferences('u1')).toEqual({ theme: 'light', defaultPageSize: '25' });
	});
});
