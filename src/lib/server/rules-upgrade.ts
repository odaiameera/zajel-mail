import { getDb } from './db/index';
import { normalizePinSender } from './db/queries/jev-learning';
import { isInboxCategory, type InboxCategory } from '$lib/types/categories';
import type { LegacyRule, Rule, RulePin, TabNote, TabRuleReason } from '$lib/types/rules';

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
 * Two things hold for every change. A rule is never made to act on more
 * mail than its owner wrote it for. And no change its owner could notice is
 * silent: the rule stays in the list, flagged, under "Needs your attention"
 * on the rules page, with the original kept in `legacy` to read, until its
 * owner has dealt with it. No rule is deleted here.
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

/** A Jev condition with something for Jev to judge. One without was always ignored. */
const hasStatement = (c: unknown) =>
	isJevCondition(c) && typeof (c as StoredRule).value === 'string' && ((c as StoredRule).value as string).trim() !== '';

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
	if (!conditions.some(hasStatement)) return { ...rule, conditions: exact };
	return { ...rule, enabled: false, attention: 'jev_condition', conditions: exact, legacy: legacyOf(rule) };
}

/** An account's sender pins, as far as turning a rule into one needs them. */
export interface PinBook {
	/** The tab the sender (an address, or `@domain`) is pinned to, or null. */
	get(sender: string): InboxCategory | null;
	/** The address pins at a domain (`@domain`): each wins over a pin for the domain. */
	under(domain: string): RulePin[];
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
 * The sender a rule's conditions name, when all they say is "mail from
 * this sender": one condition, on From, not turned round by NOT or "doesn't
 * contain" (read as the engine reads them, by truthiness: a stored
 * `negate: 1` is a NOT), with a value that is an address or an `@domain`.
 * A bare word or a domain without its `@` could be part of any address or
 * name, so those name no sender.
 */
function namedSender(rule: StoredRule): { sender: string; op: string; said: string } | null {
	const conditions = list(rule.conditions).filter(constrains);
	if (conditions.length !== 1) return null;
	const c = conditions[0];
	if (!isObject(c) || c.field !== 'from' || c.negate || typeof c.value !== 'string') return null;
	const op = typeof c.op === 'string' ? c.op : 'contains';
	if (op === 'not_contains') return null;
	const sender = normalizePinSender(c.value);
	return sender ? { sender, op, said: c.value.trim() } : null;
}

/**
 * Whether a pin for the named sender stands in for the rule without acting
 * on mail the rule left alone. The engine matched text against "Name
 * address", so which operators amount to "this sender" follows from that:
 *
 * - "contains" or "ends with" an address or an `@domain`: every message
 *   the pin acts on is one the rule matched. (The pin can match less: a
 *   rule on "@shop.co" also matched "@shop.com". Less is the safe side:
 *   that mail stays in Important, and the note left on the rule says so.)
 * - "is exactly" an address: what the rule says. (The engine only matched
 *   it for senders with no display name; the pin is what was meant, and
 *   the note says that too.)
 * - "is exactly" an `@domain` never matched anything, and "starts with"
 *   matched the display name: a pin would act where the rule didn't.
 */
function pinStandsIn(named: { sender: string; op: string }): boolean {
	if (named.op === 'contains' || named.op === 'ends_with') return true;
	return named.op === 'is' && !named.sender.startsWith('@');
}

/** What the conversion of one rule may depend on beyond the rule itself. */
export interface TabContext {
	/** The account's pins, or null when the rule's account couldn't be found. */
	pins: PinBook | null;
	/**
	 * An earlier rule in the list was switched on and stops processing. Mail
	 * it matched never reached this rule, so a pin, which sees all of a
	 * sender's mail, would do more than this rule did.
	 */
	afterStop: boolean;
	/**
	 * Senders pinned by an earlier rule of this same run. Both rules used to
	 * run on that sender's mail, and the later one's tab was the one it ended
	 * up in, so the later rule's tab replaces such a pin. A pin from before
	 * the run is never changed.
	 */
	pinnedThisRun?: ReadonlySet<string>;
}

/**
 * Tabs belong to Jev and to sender pins: a rule no longer puts mail in an
 * Inbox tab. What becomes of a rule that did depends on what else it does.
 *
 * It did nothing else:
 * - It was switched on, named one sender, and nothing stood in the way: it
 *   becomes that sender's pin. The rule stays as a switched-off stub,
 *   `tab_pinned`, saying which pin it became and what that pin matches.
 * - Otherwise it is switched off and flagged `tab_rule`, with the reason
 *   (see TabRuleReason). Where it named a sender, the note carries the pin
 *   one click would make of it. Among the reasons: the sender, or an
 *   address at the domain, is pinned to another tab already. The rule used
 *   to win there; now your pin is kept and the rule's tab is not applied.
 *
 * It did something else as well:
 * - It moved the mail to a folder or to Trash: the tab is dropped without a
 *   note. The move takes the mail out of the Inbox, where tabs mean nothing.
 * - It left the mail in the Inbox (a label, mark read, mark important): the
 *   tab is dropped, the rest keeps running, and the rule is flagged
 *   `tab_removed` so its owner knows.
 *
 * A tab action with no tab picked never did anything, and is only removed.
 * A rule already waiting to be rewritten (it had a Jev condition) is never
 * made a pin: its remaining conditions are only part of what it matched.
 */
export function retireTabAction(rule: StoredRule, ctx: TabContext): StoredRule {
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

	if (rest.length > 0) {
		const leavesInbox = rest.some(
			(a) => isObject(a) && (a.type === 'delete' || (a.type === 'moveToFolder' && typeof a.value === 'string' && a.value !== ''))
		);
		if (leavesInbox) return without;
		return { ...without, attention: 'tab_removed', legacy: legacyOf(rule) };
	}

	const named = namedSender(rule);
	const note: TabNote = { tab };
	if (named) Object.assign(note, { pin: { sender: named.sender, category: tab }, op: named.op, said: named.said });
	const flagged = (why: TabRuleReason, kept?: RulePin): StoredRule => ({
		...without,
		enabled: false,
		attention: 'tab_rule',
		legacy: legacyOf(rule),
		tabNote: { ...note, why, ...(kept ? { kept } : {}) }
	});

	if (rule.enabled !== true) return flagged('switched_off');
	if (!named || !pinStandsIn(named)) return flagged('not_one_sender');
	if (ctx.afterStop) return flagged('after_stop');
	if (!ctx.pins) return flagged('no_account');

	// A pin of yours that would now decide this sender's mail differently:
	// the sender's own, or, for a whole domain, one of its addresses'.
	const { sender } = named;
	const ours = ctx.pinnedThisRun?.has(sender) ?? false;
	const own = ctx.pins.get(sender);
	if (own && own !== tab && !ours) return flagged('pinned_elsewhere', { sender, category: own });
	const address = sender.startsWith('@') ? ctx.pins.under(sender).find((p) => p.category !== tab) : undefined;
	if (address) return flagged('pinned_elsewhere', address);

	const existing = own === tab;
	if (!existing) ctx.pins.set(sender, tab);
	return {
		...without,
		enabled: false,
		attention: 'tab_pinned',
		legacy: legacyOf(rule),
		tabNote: { ...note, ...(existing ? { existing: true } : {}) }
	};
}

/** Whether a rule, as it was before any upgrade touched it, was switched on and stopped the rules after it. */
function stopsProcessing(rule: StoredRule): boolean {
	const was = isObject(rule.legacy) ? rule.legacy : rule;
	return was.enabled === true && list(was.actions).some((a) => isObject(a) && a.type === 'stopProcessing');
}

/**
 * One account's rules as this version stores them, in their order. Anything
 * that isn't a rule is left as it is.
 */
export function upgradeRules(rules: unknown[], pins: PinBook | null): Rule[] {
	let afterStop = false;
	// The rules of this run that each pin made here speaks for, by their place in the list.
	const pinnedBy = new Map<string, number[]>();
	const out: unknown[] = [];
	rules.forEach((rule, i) => {
		if (!isObject(rule)) {
			out.push(rule);
			return;
		}
		const next = retireTabAction(retireJevCondition(rule), { pins, afterStop, pinnedThisRun: new Set(pinnedBy.keys()) });
		afterStop ||= stopsProcessing(rule);
		const note = next.tabNote as TabNote | undefined;
		if (next.attention === 'tab_pinned' && note?.pin) {
			const { sender } = note.pin;
			const earlier = pinnedBy.get(sender);
			// This rule's tab replaced the pin an earlier rule of the run made:
			// each of those rules' notes now says which tab the sender went to.
			if (earlier && !note.existing) for (const j of earlier) out[j] = restated(out[j] as StoredRule, note.pin);
			if (earlier || !note.existing) pinnedBy.set(sender, [...(earlier ?? []), i]);
		}
		out.push(next);
	});
	return out as Rule[];
}

/** A rule of this run whose sender's pin is now `pin`: a pin it became, or one it lost to a later rule. */
function restated(stub: StoredRule, pin: RulePin): StoredRule {
	const { why: _why, kept: _kept, existing: _existing, ...note } = stub.tabNote as TabNote;
	if (note.tab === pin.category) return { ...stub, attention: 'tab_pinned', tabNote: note };
	return { ...stub, attention: 'tab_rule', tabNote: { ...note, why: 'pinned_elsewhere', kept: pin } };
}

/**
 * The pins of the mail account whose rules are stored under `userEmail`, or
 * null when there is no such account. Rules are keyed by the account's
 * address and pins by its row, so this is where the two meet.
 */
export function pinBookFor(userEmail: string): PinBook | null {
	const db = getDb();
	const account = (db.prepare('SELECT id FROM mail_accounts WHERE email = ?').get(userEmail) ??
		db.prepare('SELECT id FROM mail_accounts WHERE email = ? COLLATE NOCASE').get(userEmail)) as { id: string } | undefined;
	if (!account) return null;
	const all = db.prepare('SELECT sender, category FROM jev_sender_pins WHERE account_id = ?');
	const write = db.prepare(
		`INSERT INTO jev_sender_pins (account_id, sender, category, created_at) VALUES (?, ?, ?, ?)
		 ON CONFLICT (account_id, sender) DO UPDATE SET category = excluded.category`
	);
	// Read afresh each time: a pin an earlier rule of this run became counts
	// as much as one that was there before.
	const pins = () =>
		(all.all(account.id) as { sender: string; category: string }[]).filter((p): p is RulePin => isInboxCategory(p.category));
	return {
		get: (sender) => pins().find((p) => p.sender === sender)?.category ?? null,
		under: (domain) => pins().filter((p) => !p.sender.startsWith('@') && p.sender.endsWith(domain)),
		set: (sender, category) => {
			write.run(account.id, sender, category, Date.now());
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

/** How far back the rules scheduler is sent to pick up mail the Jev worker had queued, at most. */
const REWIND_LIMIT_MS = 24 * 60 * 60_000;
/** A message is queued a little after it arrives: the scheduler starts this much before the oldest one. */
const REWIND_MARGIN_MS = 5 * 60_000;

/**
 * An account with a rule Jev judged had all its rules run by the Jev
 * worker, one queued email at a time, while the rules scheduler stood aside
 * and kept moving its own cursor on. Mail still in that queue when rules
 * became the scheduler's alone has had no rules at all, the exact ones
 * included, and the scheduler's cursor is already past it.
 *
 * So the scheduler is sent back to the oldest email still queued (a day at
 * most). Running exact rules again over mail that already had them is safe:
 * they only write what differs. Nothing is done when nothing is queued.
 */
function rewindRulesCursor(userEmail: string, now: number): void {
	const db = getDb();
	const account = db.prepare('SELECT id FROM mail_accounts WHERE email = ? COLLATE NOCASE').get(userEmail) as
		| { id: string }
		| undefined;
	if (!account) return;
	const { oldest } = db
		.prepare(`SELECT MIN(created_at) AS oldest FROM jev_decisions WHERE account_id = ? AND status = 'pending' AND backfill = 0`)
		.get(account.id) as { oldest: number | null };
	if (oldest === null) return;
	const from = new Date(Math.max(oldest - REWIND_MARGIN_MS, now - REWIND_LIMIT_MS)).toISOString();
	// Only ever back, and only a cursor that exists: the scheduler seeds one itself.
	db.prepare('UPDATE rules_cursor SET last_run = ? WHERE user_email = ? AND last_run > ?').run(from, userEmail, from);
}

/**
 * Data step: every stored rule with a Jev condition is switched off and
 * flagged, and the accounts whose rules the Jev worker was running get
 * their queued mail back in front of the rules scheduler.
 */
export function retireStoredJevConditions(now = Date.now()): void {
	const jevRan: string[] = [];
	rewriteStoredRules((rules, userEmail) => {
		// The worker ran the rules when a switched-on rule had a Jev condition.
		if (rules.some((r) => isObject(r) && r.enabled === true && list(r.conditions).some(hasStatement))) jevRan.push(userEmail);
		return rules.map((rule) => (isObject(rule) ? retireJevCondition(rule) : rule));
	});
	for (const userEmail of jevRan) rewindRulesCursor(userEmail, now);
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
