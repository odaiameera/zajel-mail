import { getDb } from './db/index';
import { normalizePinSender } from './db/queries/jev-learning';
import { isInboxCategory, type InboxCategory } from '$lib/types/categories';
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
const isTabAction = (a: unknown) => isObject(a) && a.type === 'setCategory';

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

/** An account's sender pins, as far as turning a rule into one needs them. */
export interface PinBook {
	/** Whether the sender is pinned already, to any tab. */
	has(sender: string): boolean;
	set(sender: string, category: InboxCategory): void;
}

/** Whether a condition would have constrained matching, as the engine saw it (see isUsableCondition). */
function constrains(c: unknown): boolean {
	if (!isObject(c)) return true; // unreadable: assume it mattered
	if (c.field === 'hasAttachment') return true;
	if (c.field === 'size') return Number.isFinite(parseInt(String(c.value), 10));
	if (c.field === 'from' || c.field === 'to' || c.field === 'subject' || c.field === 'body') {
		return typeof c.value === 'string' && c.value.trim() !== '';
	}
	return true; // a kind this version doesn't know: not ours to call empty
}

/**
 * The sender a rule's conditions single out, as a pin key (an address, or
 * `@domain`), or null when they say anything else.
 *
 * Only one plain, positive match on the sender is a pin. The rule engine
 * matched text against "Name address", so which operators amount to "this
 * sender" was worked out from that:
 *
 * - "contains" or "ends with" an address or an `@domain`: every message
 *   the pin acts on is one the rule matched.
 * - "is exactly" an address: what the rule says. (The engine only matched
 *   it for senders with no display name; the pin is what was meant.)
 * - "is exactly" an `@domain` never matched anything, and "starts with"
 *   matched the display name: neither is a sender, so neither is a pin.
 *
 * A bare word or a domain without its `@` could be part of any address or
 * name, so those are left for the owner too.
 */
function pinnableSender(rule: StoredRule): string | null {
	const conditions = list(rule.conditions).filter(constrains);
	if (conditions.length !== 1) return null;
	const c = conditions[0];
	if (!isObject(c) || c.field !== 'from' || c.negate === true || typeof c.value !== 'string') return null;
	const sender = normalizePinSender(c.value);
	if (!sender) return null;
	const op = c.op ?? 'contains';
	if (op === 'contains' || op === 'ends_with') return sender;
	if (op === 'is') return sender.startsWith('@') ? null : sender;
	return null;
}

/**
 * Tabs belong to Jev and to sender pins: a rule no longer puts mail in an
 * Inbox tab. What becomes of a rule that did depends on what else it does.
 *
 * - Nothing else, and it is switched on and singles out one sender: that
 *   is exactly a sender pin, so it becomes one (unless the sender is pinned
 *   already, when your pin stands) and the rule is deleted: `null`.
 * - Nothing else, but no pin can stand in for it (several conditions, a
 *   word in the subject, switched off, or no account to pin for): it is
 *   switched off and flagged `tab_rule`. It has nothing left to do, and is
 *   kept so its owner can see what it said.
 * - It also moves the mail to a folder or to Trash: the tab is dropped
 *   without a note. The move takes the mail out of the Inbox, where tabs
 *   mean nothing.
 * - It also does something that leaves the mail in the Inbox (a label,
 *   mark read, mark important): the tab is dropped, the rest keeps running,
 *   and the rule is flagged `tab_removed` so its owner knows.
 *
 * A tab action with no tab picked never did anything, and is only removed.
 * A rule already waiting to be rewritten (it had a Jev condition) is never
 * made a pin: its remaining conditions are only part of what it matched.
 *
 * `pins` is null when the rule's account couldn't be found.
 */
export function retireTabAction(rule: StoredRule, pins: PinBook | null): StoredRule | null {
	const actions = list(rule.actions);
	if (!actions.some(isTabAction)) return rule;
	const rest = actions.filter((a) => !isTabAction(a));
	// Later actions overrode earlier ones, so the last tab is the one it set.
	const tab = actions
		.filter(isTabAction)
		.map((a) => (a as StoredRule).value)
		.filter(isInboxCategory)
		.at(-1);
	const without = { ...rule, actions: rest };

	if (!tab) return without;
	// Flagged for its Jev condition already: that is the note it keeps. The
	// original, tab included, is in `legacy` from then.
	if (rule.attention === 'jev_condition') return { ...without, legacy: legacyOf(rule) };

	if (rest.length === 0) {
		const sender = rule.enabled === true ? pinnableSender(rule) : null;
		if (sender && pins) {
			if (!pins.has(sender)) pins.set(sender, tab);
			return null;
		}
		return { ...without, enabled: false, attention: 'tab_rule', legacy: legacyOf(rule) };
	}

	const leavesInbox = rest.some(
		(a) => isObject(a) && (a.type === 'delete' || (a.type === 'moveToFolder' && typeof a.value === 'string' && a.value !== ''))
	);
	if (leavesInbox) return without;
	return { ...without, attention: 'tab_removed', legacy: legacyOf(rule) };
}

/**
 * One account's rules as this version stores them, in their order. Anything
 * that isn't a rule is left as it is.
 */
export function upgradeRules(rules: unknown[], pins: PinBook | null): Rule[] {
	const out: unknown[] = [];
	for (const rule of rules) {
		if (!isObject(rule)) {
			out.push(rule);
			continue;
		}
		const next = retireTabAction(retireJevCondition(rule), pins);
		if (next) out.push(next);
	}
	return out as Rule[];
}

/**
 * The pins of the mail account whose rules are stored under `userEmail`, or
 * null when there is no such account. Rules are keyed by the account's
 * address and pins by its row, so this is where the two meet.
 *
 * A pin made here by one rule is replaced by a later rule for the same
 * sender, as the later rule's tab was the one that stood when both ran. A
 * pin that was there before is yours, and is never changed.
 */
export function pinBookFor(userEmail: string): PinBook | null {
	const db = getDb();
	const account = (db.prepare('SELECT id FROM mail_accounts WHERE email = ?').get(userEmail) ??
		db.prepare('SELECT id FROM mail_accounts WHERE email = ? COLLATE NOCASE').get(userEmail)) as { id: string } | undefined;
	if (!account) return null;
	const find = db.prepare('SELECT 1 FROM jev_sender_pins WHERE account_id = ? AND sender = ?');
	const write = db.prepare(
		`INSERT INTO jev_sender_pins (account_id, sender, category, created_at) VALUES (?, ?, ?, ?)
		 ON CONFLICT (account_id, sender) DO UPDATE SET category = excluded.category`
	);
	const made = new Set<string>();
	return {
		has: (sender) => !made.has(sender) && !!find.get(account.id, sender),
		set: (sender, category) => {
			write.run(account.id, sender, category, Date.now());
			made.add(sender);
		}
	};
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

/**
 * Data step: no stored rule sets an Inbox tab any more. Rules that only did
 * that for one sender become that account's sender pins. (Jev conditions
 * are retired here as well, so a rule that slipped past the earlier step
 * can't be mistaken for a plain sender match.)
 */
export function retireStoredTabActions(): void {
	rewriteStoredRules((rules, userEmail) => upgradeRules(rules, pinBookFor(userEmail)));
}
