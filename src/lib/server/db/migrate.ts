import { getDb } from './index';
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

export function runMigrations(): void {
	const db = getDb();

	db.exec(`
		CREATE TABLE IF NOT EXISTS _migrations (
			name       TEXT PRIMARY KEY,
			applied_at TEXT NOT NULL DEFAULT (datetime('now'))
		)
	`);

	const seen = db.prepare('SELECT 1 FROM _migrations WHERE name = ?');
	const mark = db.prepare('INSERT INTO _migrations (name) VALUES (?)');

	const ordered = Object.keys(MIGRATION_SOURCES).sort();

	for (const path of ordered) {
		const name = path.split('/').pop() ?? path;
		if (seen.get(name)) continue;

		const sql = MIGRATION_SOURCES[path];
		const tx = db.transaction(() => {
			db.exec(sql);
			mark.run(name);
		});

		try {
			tx();
		} catch (err) {
			// A failed migration used to be swallowed entirely, on the theory
			// that it would surface through later request errors. It does not:
			// the app boots, the build passes and the tests pass, while the
			// schema silently lacks whatever the migration was adding, and the
			// first symptom is an unrelated-looking query error much later.
			// One line per failure, once per start, is not log spam.
			console.error(
				`[migrate] ${name} failed and was not applied:`,
				err instanceof Error ? err.message : err
			);
			logEvent('error', 'db', 'migration_failed', { migration: name, ...errorFields(err) });
		}
	}
}
