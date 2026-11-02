import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it, vi } from 'vitest';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'zajel-migrate-')), 'test.db');
vi.mock('$lib/server/log', () => ({ logEvent: vi.fn(), errorFields: (e: unknown) => ({ error: String(e) }) }));

import { getDb } from './index';
import { MigrationError, runMigrations } from './migrate';

const applied = () =>
	(getDb().prepare('SELECT name FROM _migrations ORDER BY name').all() as { name: string }[]).map((r) => r.name);
const hasTable = (name: string) =>
	!!getDb().prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);

describe('runMigrations', () => {
	it('stops at the first migration that fails, rolls it back, and refuses to go on', () => {
		const sources = {
			'./migrations/001_a.sql': 'CREATE TABLE a (x);',
			'./migrations/002_b.sql': 'CREATE TABLE b (x); INSERT INTO nope VALUES (1);',
			'./migrations/003_c.sql': 'CREATE TABLE c (x);'
		};
		let thrown: unknown;
		try {
			runMigrations(sources);
		} catch (err) {
			thrown = err;
		}
		expect(thrown).toBeInstanceOf(MigrationError);
		expect((thrown as MigrationError).migration).toBe('002_b.sql');
		expect((thrown as Error).message).toContain('002_b.sql');
		expect((thrown as Error).message).toContain('restart');

		expect(applied()).toEqual(['001_a.sql']);
		expect(hasTable('a')).toBe(true);
		expect(hasTable('b')).toBe(false); // the failed one is rolled back whole
		expect(hasTable('c')).toBe(false); // and the ones after it were not attempted

		// Once the migration is fixed, the next start picks up where it stopped.
		runMigrations({ ...sources, './migrations/002_b.sql': 'CREATE TABLE b (x);' });
		expect(applied()).toEqual(['001_a.sql', '002_b.sql', '003_c.sql']);
		expect(hasTable('c')).toBe(true);
	});
});
