import type { Cookies } from '@sveltejs/kit';
import type { Rule } from '$lib/types/rules';
import { getRules, setRules, hasRulesRow } from './db/queries/rules';
import { pinBookFor, upgradeRules } from './rules-upgrade';

const LEGACY_COOKIE = 'mail_rules';

/**
 * Load a user's rules from SQLite. If they have no row yet but a legacy
 * per-browser `mail_rules` cookie is present (pre-Phase rules storage), import
 * it once into SQLite and clear the cookie so rules become device-independent.
 */
export function loadRules(userEmail: string, cookies: Cookies): Rule[] {
	if (hasRulesRow(userEmail)) return getRules(userEmail);

	const raw = cookies.get(LEGACY_COOKIE);
	if (raw) {
		try {
			const parsed = JSON.parse(decodeURIComponent(raw));
			if (Array.isArray(parsed)) {
				const rules = upgradeRules(parsed, pinBookFor(userEmail));
				setRules(userEmail, rules);
				cookies.delete(LEGACY_COOKIE, { path: '/' });
				return rules;
			}
		} catch {
			// Malformed cookie — ignore and fall through to empty.
		}
	}
	return getRules(userEmail);
}

/**
 * Persist a user's rules to SQLite and drop the legacy cookie if present.
 * What is stored is brought up to this version first: the rules come from
 * a browser, and a tab left open across an upgrade sends them as they were
 * (which can mean a rule that only set an Inbox tab arrives here, and
 * leaves as a sender pin).
 */
export function saveRules(userEmail: string, rules: Rule[], cookies: Cookies): void {
	setRules(userEmail, upgradeRules(rules, pinBookFor(userEmail)));
	if (cookies.get(LEGACY_COOKIE)) cookies.delete(LEGACY_COOKIE, { path: '/' });
}
