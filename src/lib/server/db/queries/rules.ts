import { getDb } from '../index';
import type { ActionRule } from '$lib/types/rules';
import { accountIdForEmail } from './account-tasks';
import { listRules } from '../../rules/store';
import { toActionRule } from '../../rules-store';

let _stmts: ReturnType<typeof prepareStmts> | null = null;
function prepareStmts() {
	const db = getDb();
	return {
		getCursor: db.prepare('SELECT last_run FROM rules_cursor WHERE user_email = ?'),
		setCursor: db.prepare(
			`INSERT INTO rules_cursor (user_email, last_run, updated_at)
			 VALUES (@userEmail, @lastRun, datetime('now'))
			 ON CONFLICT (user_email) DO UPDATE SET
			   last_run = excluded.last_run,
			   updated_at = datetime('now')`
		)
	};
}
function stmts() {
	return (_stmts ??= prepareStmts());
}

/** The rules of the mail account with this address, read from the rules table. */
export function getRules(userEmail: string): ActionRule[] {
	const accountId = accountIdForEmail(userEmail);
	return accountId ? listRules(accountId).map(toActionRule) : [];
}

/** ISO timestamp the auto-apply worker last processed up to, or null. */
export function getRulesCursor(userEmail: string): string | null {
	const row = stmts().getCursor.get(userEmail) as { last_run: string | null } | undefined;
	return row?.last_run ?? null;
}

export function setRulesCursor(userEmail: string, iso: string): void {
	stmts().setCursor.run({ userEmail, lastRun: iso });
}
