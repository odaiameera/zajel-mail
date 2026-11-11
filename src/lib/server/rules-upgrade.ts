import { getDb } from './db/index';
import type { LegacyRule, Rule } from '$lib/types/rules';

/**
 * Bringing stored rules up to what a rule is now.
 *
 * Rules are one JSON array per mail account, stored as the browser sent
 * them, so a change to what a rule may contain has to be made to the stored
 * arrays too. Each change here is a pure function over one account's rules,
 * safe to run any number of times, used in two places:
 *
 * - once over every account, from the migration runner (see `DATA_STEPS` in
 *   db/migrate.ts), and
 * - on every save (rules-store.ts), since a browser tab left open across an
 *   upgrade still holds the old rules and would save them back.
 *
 * The rule that matters most: a rule is never made to match more mail than
 * its owner wrote it for, and never dropped without a word. One that can't
 * be carried over is switched off and listed under "Needs your attention"
 * on the rules page, with the original kept in `legacy` to read.
 */

/** A rule as stored: whatever a browser last sent, from any version. */
type StoredRule = Record<string, unknown>;

function isObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

function list(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

const isJevCondition = (c: unknown) => isObject(c) && c.field === 'jev';

/** The rule as it stands, to keep beside the changed one. Taken once: an earlier copy is the true original. */
function legacyOf(rule: StoredRule): LegacyRule {
	if (isObject(rule.legacy)) return rule.legacy as unknown as LegacyRule;
	return {
		enabled: rule.enabled === true,
		logic: rule.logic === 'anyof' ? 'anyof' : 'allof',
		conditions: structuredClone(list(rule.conditions)) as LegacyRule['conditions'],
		actions: structuredClone(list(rule.actions)) as LegacyRule['actions']
	};
}

/**
 * Rules are exact-match only: a rule no longer has conditions Jev judges.
 *
 * A rule with such a condition is switched off and flagged, with its exact
 * conditions left in place as a start for rewriting it. It is not simply
 * stripped of the Jev condition and left running: "from the shop AND it's a
 * receipt" would become "from the shop", and act on mail it was never meant
 * for. (The engine refuses a flagged rule even if it is switched back on.)
 *
 * A Jev condition with no statement is only removed. The engine always
 * ignored those, so the rule matches exactly what it matched before.
 */
export function retireJevCondition(rule: StoredRule): StoredRule {
	const conditions = list(rule.conditions);
	if (!conditions.some(isJevCondition)) return rule;
	const exact = conditions.filter((c) => !isJevCondition(c));
	const hadStatement = conditions.some(
		(c) => isJevCondition(c) && typeof (c as StoredRule).value === 'string' && ((c as StoredRule).value as string).trim() !== ''
	);
	if (!hadStatement) return { ...rule, conditions: exact };
	return { ...rule, enabled: false, attention: 'jev_condition', conditions: exact, legacy: legacyOf(rule) };
}

/** One account's rules as this version stores them. Anything that isn't a rule is left as it is. */
export function upgradeRules(rules: unknown[]): Rule[] {
	return rules.map((rule) => (isObject(rule) ? retireJevCondition(rule) : rule)) as Rule[];
}

/** Rewrite every account's stored rules with `upgrade`, leaving rows it doesn't change (or can't read) alone. */
function rewriteStoredRules(upgrade: (rules: unknown[], userEmail: string) => unknown[]): void {
	const db = getDb();
	const rows = db.prepare('SELECT user_email, rules_json FROM user_rules').all() as {
		user_email: string;
		rules_json: string;
	}[];
	const write = db.prepare(`UPDATE user_rules SET rules_json = ?, updated_at = datetime('now') WHERE user_email = ?`);
	for (const row of rows) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(row.rules_json);
		} catch {
			continue; // read as "no rules" everywhere else, too
		}
		if (!Array.isArray(parsed)) continue;
		const next = JSON.stringify(upgrade(parsed, row.user_email));
		if (next !== JSON.stringify(parsed)) write.run(next, row.user_email);
	}
}

/** Data step: every stored rule with a Jev condition is switched off and flagged. */
export function retireStoredJevConditions(): void {
	rewriteStoredRules((rules) => rules.map((rule) => (isObject(rule) ? retireJevCondition(rule) : rule)));
}
