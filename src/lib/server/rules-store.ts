import type { Cookies } from '@sveltejs/kit';
import type { ActionRule, Rule, RuleAction } from '$lib/types/rules';
import { getDb } from './db/index';
import { accountIdForEmail } from './db/queries/account-tasks';
import { countRules, importRules, listRules } from './rules/store';
import { pinBookFor, toTableRules, upgradeRules } from './rules/upgrade';

const LEGACY_COOKIE = 'mail_rules';

/**
 * A stopgap while the page and the engine still work on rules with a list
 * of actions: the rules table, read in that shape. Removed with them.
 */
export function toActionRule(rule: Rule): ActionRule {
	const actions: RuleAction[] = [];
	const t = rule.target;
	if (t.kind === 'folder') actions.push({ type: 'moveToFolder', value: t.mailboxId });
	if (t.kind === 'label') actions.push({ type: 'applyLabel', value: t.mailboxId });
	if (t.kind === 'trash') actions.push({ type: 'delete' });
	if (rule.markRead) actions.push({ type: 'markRead' });
	if (rule.star) actions.push({ type: 'markImportant' });
	if (rule.stop) actions.push({ type: 'stopProcessing' });
	return {
		id: rule.id,
		name: rule.name,
		enabled: rule.enabled,
		logic: rule.logic,
		conditions: rule.conditions,
		actions,
		createdAt: rule.createdAt,
		...(rule.attention && rule.attention !== 'split' ? { attention: rule.attention } : {}),
		...(rule.legacy ? { legacy: rule.legacy } : {}),
		...(rule.note?.tab ? { tabNote: rule.note.tab } : {})
	};
}

/**
 * Load a user's rules from the rules table. If the account has none yet but
 * a legacy per-browser `mail_rules` cookie is present (pre-Phase rules
 * storage), import it once and clear the cookie.
 */
export function loadRules(userEmail: string, cookies: Cookies): ActionRule[] {
	const accountId = accountIdForEmail(userEmail);
	if (!accountId) return [];
	const raw = cookies.get(LEGACY_COOKIE);
	if (raw && countRules(accountId) === 0) {
		try {
			const parsed = JSON.parse(decodeURIComponent(raw));
			if (Array.isArray(parsed)) {
				replaceRules(accountId, userEmail, parsed);
				cookies.delete(LEGACY_COOKIE, { path: '/' });
			}
		} catch {
			// Malformed cookie — ignore and fall through to empty.
		}
	}
	return listRules(accountId).map(toActionRule);
}

/** The whole list, as the page still saves it, converted as the upgrade converts stored rules. */
function replaceRules(accountId: string, userEmail: string, rules: unknown[]): void {
	getDb().transaction(() => {
		getDb().prepare('DELETE FROM rules WHERE account_id = ?').run(accountId);
		importRules(accountId, toTableRules(upgradeRules(rules, pinBookFor(userEmail))));
	})();
}

/**
 * Persist a user's rules and drop the legacy cookie if present. What is
 * stored is brought up to this version first: the rules come from a
 * browser, and a tab left open across an upgrade sends them as they were.
 */
export function saveRules(userEmail: string, rules: ActionRule[], cookies: Cookies): void {
	const accountId = accountIdForEmail(userEmail);
	if (!accountId) return;
	replaceRules(accountId, userEmail, rules);
	if (cookies.get(LEGACY_COOKIE)) cookies.delete(LEGACY_COOKIE, { path: '/' });
}
