import { getDb } from './index';
import { repairAiSettingsColumns } from '$lib/server/ai/settings';
import { moveStoredRulesToTable, retireStoredJevConditions, retireStoredTabActions } from '$lib/server/rules/upgrade';
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
	// switched off and flagged for their owner (see rules/upgrade.ts). The
	// accounts that had one also get the mail the Jev worker still had
	// queued put back in front of the rules scheduler.
	{
		name: 'data/rules_exact_only',
		needs: ['004_rules.sql', '006_auth.sql', '015_jev_backfill.sql'],
		run: () => retireStoredJevConditions()
	},
	// Tabs belong to Jev and to sender pins: no rule sets one any more. A
	// rule that only did that for one sender becomes that account's pin,
	// and stays in the list as a note saying so.
	{
		name: 'data/rule_tabs_to_pins',
		needs: ['004_rules.sql', '006_auth.sql', '014_jev_learning.sql'],
		run: retireStoredTabActions
	},
	// Rules move from one JSON list per address into the rules table, one
	// row each under their mail account, a rule that filed into several
	// places becoming one rule per place. After the two steps above, so what
	// it copies is exact-only and sets no tab. `user_rules` is left as it is.
	{
		name: 'data/rules_to_table',
		needs: ['006_auth.sql', '030_rules.sql', 'data/rules_exact_only', 'data/rule_tabs_to_pins'],
		run: () => moveStoredRulesToTable()
	},
	// What nothing reads or writes any more: the rules scheduler's place
	// (the pipeline's took over from it in 032), Jev's per-rule feedback and
	// its answers about rule conditions (rules haven't had Jev conditions
	// since the first step above). A step, not a .sql file, because every
	// .sql file runs before any step, and the rule steps above still read
	// and write `rules_cursor` on a database that hasn't run them yet.
	// `user_rules`, `label_meta` and `folder_meta` are kept: they are the
	// only copy of the rules and colours as they were before this upgrade.
	{
		name: 'data/drop_unused',
		needs: ['032_mail_pipeline.sql', 'data/rules_exact_only', 'data/rule_tabs_to_pins', 'data/rules_to_table'],
		run: () => dropUnused()
	}
];

/** Drop the tables and the column nothing uses (see `data/drop_unused`). Safe to run again. */
function dropUnused(): void {
	const db = getDb();
	db.exec('DROP TABLE IF EXISTS rules_cursor');
	db.exec('DROP TABLE IF EXISTS jev_rule_feedback');
	const columns = db.prepare('PRAGMA table_info(jev_decisions)').all() as { name: string }[];
	if (columns.some((c) => c.name === 'rules_json')) db.exec('ALTER TABLE jev_decisions DROP COLUMN rules_json');
}

/**
 * Say what is about to change, once, before any of it does: the database
 * file, and how many migrations and one-time steps are to run. Nothing when
 * nothing is. The app takes no backup itself (see the README's Upgrading).
 */
function announce(file: string, pendingMigrations: string[], applied: string[]): void {
	// The steps that will run: not done yet, and with everything they need
	// done already or about to be.
	const done = new Set([...applied, ...pendingMigrations]);
	let steps = 0;
	for (const step of DATA_STEPS) {
		if (done.has(step.name) || !step.needs.every((name) => done.has(name))) continue;
		done.add(step.name);
		steps++;
	}
	if (pendingMigrations.length === 0 && steps === 0) return;
	const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
	const what = [
		...(pendingMigrations.length ? [count(pendingMigrations.length, 'migration', 'migrations')] : []),
		...(steps ? [count(steps, 'one-time step', 'one-time steps')] : [])
	].join(' and ');
	console.log(`[migrate] Upgrading the database at ${file}: ${what} to apply`);
	logEvent('info', 'db', 'upgrade_started', { file, migrations: pendingMigrations.length, steps });
}

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
	const nameOf = (path: string) => path.split('/').pop() ?? path;

	announce(
		db.name,
		ordered.map(nameOf).filter((name) => !seen.get(name)),
		(db.prepare('SELECT name FROM _migrations').all() as { name: string }[]).map((r) => r.name)
	);

	for (const path of ordered) {
		const name = nameOf(path);
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
