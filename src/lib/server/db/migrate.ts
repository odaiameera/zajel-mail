import { getDb } from './index';
import { repairAiSettingsColumns } from '$lib/server/ai/settings';
import { retireStoredJevConditions } from '$lib/server/rules-upgrade';
import { errorFields, logEvent } from '$lib/server/log';

/**
 * Bundle migration SQL into the build at compile time. Vite's eager glob
 * with `?raw` inlines each .sql file as a string the runtime can execute
 * directly — no `readdirSync` from `src/` (the runtime image only ships
 * `build/`). Keeping this as a pure data import means evaluating the
 * module is side-effect free; the DB connection only opens inside
 * {@link runMigrations} below.
 */
const MIGRATION_SOURCES = import.meta.glob('./migrations/*.sql', {
	query: '?raw',
	import: 'default',
	eager: true
}) as Record<string, string>;

/**
 * Changes to stored rows that SQL can't make: the rules are JSON a browser
 * sent, and changing what a rule may contain means rewriting it. Each step
 * runs once, after the migrations that create what it reads, in a
 * transaction with its own marker in `_migrations`, and is safe to run
 * again should that marker ever be lost.
 */
const DATA_STEPS: { name: string; needs: string[]; run: () => void }[] = [
	// Rules are exact-match only: rules with a condition Jev judged are
	// switched off and flagged for their owner (see rules-upgrade.ts).
	{ name: 'data/rules_exact_only', needs: ['004_rules.sql'], run: retireStoredJevConditions }
];

/** A migration that did not apply. The server refuses requests until it does. */
export class MigrationError extends Error {
	constructor(
		readonly migration: string,
		cause: string
	) {
		super(
			`Database migration ${migration} failed: ${cause}. Later migrations were not attempted. ` +
				`Fix the database at DATABASE_PATH (restore a backup, or apply the migration by hand) and restart.`
		);
		this.name = 'MigrationError';
	}
}

/**
 * Apply every migration not yet recorded in `_migrations`, in name order,
 * each in its own transaction with its marker. Stops at the first failure:
 * the app used to carry on to the next migration and then serve requests on
 * a schema missing whatever the failed one added, so the first symptom was
 * an unrelated-looking query error much later. `sources` is for tests.
 */
export function runMigrations(sources: Record<string, string> = MIGRATION_SOURCES): void {
	const db = getDb();

	db.exec(`
		CREATE TABLE IF NOT EXISTS _migrations (
			name       TEXT PRIMARY KEY,
			applied_at TEXT NOT NULL DEFAULT (datetime('now'))
		)
	`);

	const seen = db.prepare('SELECT 1 FROM _migrations WHERE name = ?');
	const mark = db.prepare('INSERT INTO _migrations (name) VALUES (?)');

	const ordered = Object.keys(sources).sort();

	for (const path of ordered) {
		const name = path.split('/').pop() ?? path;
		if (seen.get(name)) continue;

		const sql = sources[path];
		const tx = db.transaction(() => {
			db.exec(sql);
			mark.run(name);
		});

		try {
			tx();
		} catch (err) {
			const cause = err instanceof Error ? err.message : String(err);
			console.error(`[migrate] ${name} failed and was not applied:`, cause);
			logEvent('error', 'db', 'migration_failed', { migration: name, ...errorFields(err) });
			throw new MigrationError(name, cause);
		}
	}

	// Migration 026 gained two columns after it first shipped, and a migration
	// runs once by name, so databases that ran the first version are patched
	// here. Only once 026 itself has run: before that there is no ai_settings.
	if (seen.get('026_search_index.sql')) repairAiSettingsColumns();

	for (const step of DATA_STEPS) {
		if (seen.get(step.name) || !step.needs.every((name) => seen.get(name))) continue;
		const tx = db.transaction(() => {
			step.run();
			mark.run(step.name);
		});
		try {
			tx();
		} catch (err) {
			const cause = err instanceof Error ? err.message : String(err);
			console.error(`[migrate] ${step.name} failed and was not applied:`, cause);
			logEvent('error', 'db', 'migration_failed', { migration: step.name, ...errorFields(err) });
			throw new MigrationError(step.name, cause);
		}
	}
}
