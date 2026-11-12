import { getDb } from '../index';

/** One-time tasks per mail account. See migration 028_account_tasks.sql. */

let _stmts: ReturnType<typeof prepareStmts> | null = null;

// Prepared lazily, as in the other query modules: preparing at module scope
// would open the database during `vite build`'s SSR pass.
function prepareStmts() {
	const db = getDb();
	return {
		done: db.prepare('SELECT 1 FROM account_tasks WHERE account_id = ? AND name = ?'),
		mark: db.prepare(
			`INSERT INTO account_tasks (account_id, name, done_at) VALUES (?, ?, ?)
			 ON CONFLICT (account_id, name) DO NOTHING`
		)
	};
}
function stmts() {
	return (_stmts ??= prepareStmts());
}

export function isAccountTaskDone(accountId: string, name: string): boolean {
	return !!stmts().done.get(accountId, name);
}

export function markAccountTaskDone(accountId: string, name: string): void {
	stmts().mark.run(accountId, name, new Date().toISOString());
}
