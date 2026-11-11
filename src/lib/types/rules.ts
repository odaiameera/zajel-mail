import type { InboxCategory } from './categories';

/**
 * A rule matches mail exactly: by sender, recipient, subject, body, size or
 * attachment. It files what it matches into one place (a folder, a label,
 * Trash, Archive or Junk, or nowhere), and may also mark it read, star it,
 * or stop the rules after it. Rules once also took a plain-English
 * condition that Jev judged, could put mail in an Inbox tab, and held a
 * free list of actions. All three are gone: the tabs belong to Jev and to
 * sender pins, and a rule that filed into several places became one rule
 * per place. A stored rule that relied on any of them is listed for its
 * owner (see `RuleAttention`).
 */
export type RuleConditionField = 'from' | 'to' | 'subject' | 'body' | 'size' | 'hasAttachment';
export type RuleConditionOp = 'contains' | 'not_contains' | 'is' | 'starts_with' | 'ends_with';
export type RuleLogic = 'allof' | 'anyof';

const CONDITION_FIELDS: ReadonlySet<string> = new Set<RuleConditionField>([
	'from',
	'to',
	'subject',
	'body',
	'size',
	'hasAttachment'
]);

export interface RuleCondition {
	id: string;
	field: RuleConditionField;
	op: RuleConditionOp;
	value: string;
	negate: boolean;
}

/**
 * The actions of a rule as rules were stored before each rule filed into
 * one place (see `ActionRule`). Only the upgrade reads them.
 */
export type RuleActionType =
	| 'moveToFolder'
	| 'applyLabel'
	| 'markRead'
	| 'markImportant'
	| 'delete'
	| 'stopProcessing';

export interface RuleAction {
	type: RuleActionType;
	/** Mailbox id for folder/label actions. */
	value?: string;
}

/**
 * Why a rule is listed under "Needs your attention" on the rules page.
 *
 * - `jev_condition`: it had a condition Jev judged, which rules no longer
 *   have. The rule is switched off, and never runs until its owner has
 *   rewritten it with exact conditions: without the Jev condition it would
 *   match more mail than it was written for.
 * - `tab_rule`: all it did was put mail in an Inbox tab, which rules no
 *   longer do, and the upgrade didn't turn it into a sender pin (`TabNote`
 *   says why). It is switched off too: with its only action gone there is
 *   nothing for it to do.
 * - `tab_pinned`: all it did was put one sender's mail in a tab, and it
 *   became that sender's pin. What is left is a switched-off stub that says
 *   so, with exactly what the pin matches, until the owner dismisses it.
 * - `tab_removed`: it put mail in a tab beside something else (a label,
 *   say). The tab part is gone and the rest still runs; this is only a note
 *   for the owner, who can dismiss it.
 *
 * - `split`: it filed mail in several places, and a rule now files into
 *   one, so it became several rules side by side. Every one after the first
 *   says so (`RuleNote.splitInto`) until the owner dismisses it; together
 *   they do what the one rule did.
 *
 * No conversion is silent: every rule an upgrade changes in a way its owner
 * could notice carries one of these until they have seen it.
 */
export type RuleAttention = 'jev_condition' | 'tab_rule' | 'tab_pinned' | 'tab_removed' | 'split';

/** A sender pin: an address or `@domain`, and the tab its new mail goes to. */
export interface RulePin {
	sender: string;
	category: InboxCategory;
}

/**
 * Why the upgrade left a rule that only set a tab as a rule (`tab_rule`)
 * instead of making it a pin:
 *
 * - `not_one_sender`: its conditions don't single out one sender.
 * - `switched_off`: it was off, and a pin would start what it wasn't doing.
 * - `no_account`: no mail account was found to keep the pin for.
 * - `after_stop`: an earlier rule stops processing, so this one didn't see
 *   all of the sender's mail, and a pin would.
 * - `pinned_elsewhere`: a pin of yours already decides this sender's mail
 *   differently (`kept`). The rule used to win; the pin was kept.
 */
export type TabRuleReason = 'not_one_sender' | 'switched_off' | 'no_account' | 'after_stop' | 'pinned_elsewhere';

/** What became of a rule that only put mail in a tab, for its owner to read. */
export interface TabNote {
	/** The tab the rule put mail in. */
	tab: InboxCategory;
	/**
	 * `tab_pinned`: the pin the rule became. `tab_rule`: the pin one click
	 * would make of it, when its one condition names a sender.
	 */
	pin?: RulePin;
	/** How the rule matched that sender, and the text it matched on, as written. */
	op?: string;
	said?: string;
	/** `tab_pinned`: the sender was pinned to this tab already, by you. */
	existing?: boolean;
	/** `tab_rule`: why it wasn't made a pin. */
	why?: TabRuleReason;
	/** `pinned_elsewhere`: your pin that was kept. */
	kept?: RulePin;
}

/**
 * A rule as it was before an upgrade changed it, kept so its owner can read
 * what it said. Its parts are no longer valid rule parts (a `jev` condition,
 * say), so they are typed loosely and only ever shown, never run.
 */
export interface LegacyRule {
	enabled: boolean;
	logic: RuleLogic;
	conditions: { field: string; op?: string; value?: string; negate?: boolean; strictness?: string }[];
	actions: { type: string; value?: string }[];
}

/**
 * A rule as rules were stored before this version: a free list of actions,
 * kept per mail address. Only the upgrade reads it now, to bring what was
 * stored then into the rules table (see rules/upgrade.ts).
 */
export interface ActionRule {
	id: string;
	name: string;
	enabled: boolean;
	logic: RuleLogic;
	conditions: RuleCondition[];
	actions: RuleAction[];
	createdAt: number;
	/** Set by an upgrade that had to change this rule; cleared when its owner deals with it. */
	attention?: RuleAttention;
	/** The rule as it was before that upgrade. */
	legacy?: LegacyRule;
	/** For `tab_rule` and `tab_pinned`: what became of the rule's tab. */
	tabNote?: TabNote;
}

/** The folders with a role a rule can file into, named by that role. */
export type RuleRole = 'trash' | 'archive' | 'junk';
export const RULE_ROLES: readonly RuleRole[] = ['trash', 'archive', 'junk'];

/**
 * The one place a rule files what it matches. A folder or a label is named
 * by its mailbox id; Trash, Archive and Junk by their role.
 */
export type RuleTarget = { kind: 'none' } | { kind: 'folder' | 'label'; mailboxId: string } | { kind: RuleRole };

/** What the server keeps beside a flagged rule, for its owner to read. */
export interface RuleNote {
	/** For `tab_rule` and `tab_pinned`: what became of the rule's tab. */
	tab?: TabNote;
	/** The rule this one came from filed mail in this many places, and is now this many rules. */
	splitInto?: number;
}

/** What a rule's owner says about it: everything a client may send. */
export interface RuleDraft {
	name: string;
	enabled: boolean;
	logic: RuleLogic;
	conditions: RuleCondition[];
	target: RuleTarget;
	markRead: boolean;
	/** Flag the message (shown as a star). */
	star: boolean;
	/** Run no later rule on a message this one matched. */
	stop: boolean;
}

/** One thing wrong with a rule a client sent, for the part of the editor it is about. */
export interface RuleProblem {
	field: 'name' | 'logic' | 'conditions' | 'target' | 'actions';
	/** For a condition: which one, counted from 0. */
	index?: number;
	message: string;
}

/**
 * A stored rule. `attention`, `note` and `legacy` are the server's: an
 * upgrade sets them and the owner's dealing with the rule clears them. No
 * client ever sends them.
 */
export interface Rule extends RuleDraft {
	id: string;
	/** Its place in the account's list: rules run in this order. */
	position: number;
	createdAt: number;
	updatedAt: number;
	attention?: RuleAttention;
	note?: RuleNote;
	legacy?: LegacyRule;
}

/**
 * A condition is usable only if it would actually constrain matching. An
 * empty text value is dropped so a half-finished rule never becomes
 * match-everything.
 */
export function isUsableCondition(c: RuleCondition): boolean {
	switch (c.field) {
		case 'from':
		case 'to':
		case 'subject':
		case 'body':
			return c.value.trim().length > 0;
		case 'size':
			return Number.isFinite(parseInt(c.value, 10));
		case 'hasAttachment':
			return true;
		default:
			return false;
	}
}

/**
 * Whether every condition is of a kind rules still have. Stored rules are
 * whatever a browser last sent, so one can carry a condition this version
 * doesn't know (a `jev` one from before they were removed). Such a rule
 * must not run on its other conditions alone: that would widen it.
 */
export function hasOnlyKnownConditions(rule: { conditions: RuleCondition[] }): boolean {
	return Array.isArray(rule.conditions) && rule.conditions.every((c) => CONDITION_FIELDS.has(c?.field));
}

/**
 * Whether an upgrade switched the rule off for good: it never runs again as
 * it is. Its owner rewrites it, deletes it or, for a rule that became a
 * pin, just dismisses what is left of it.
 */
export function needsRewrite(rule: { attention?: RuleAttention }): boolean {
	return rule.attention === 'jev_condition' || rule.attention === 'tab_rule' || rule.attention === 'tab_pinned';
}

/**
 * Whether a rule may act on mail at all: switched on, not waiting for its
 * owner to rewrite it (even if someone switched it back on without doing
 * so), and made only of conditions this version can match.
 */
export function isRunnable(rule: Pick<Rule, 'enabled' | 'attention' | 'conditions'>): boolean {
	// Stored rules are whatever a browser sent: an entry may not be a rule at all.
	if (!rule || typeof rule !== 'object') return false;
	return !!rule.enabled && !needsRewrite(rule) && hasOnlyKnownConditions(rule);
}

/** Whether one condition holds, given whether it matched: NOT flips it. */
export function conditionHolds(c: RuleCondition, matched: boolean): boolean {
	return c.negate ? !matched : matched;
}

/** Whether a rule matches, given whether each usable condition matched. */
export function ruleHolds(
	rule: { conditions: RuleCondition[]; logic: RuleLogic },
	matches: (c: RuleCondition) => boolean
): boolean {
	if (!hasOnlyKnownConditions(rule)) return false; // never on part of a rule
	const conds = rule.conditions.filter(isUsableCondition);
	if (conds.length === 0) return false; // never match-everything
	const results = conds.map((c) => conditionHolds(c, matches(c)));
	return rule.logic === 'anyof' ? results.some(Boolean) : results.every(Boolean);
}

/** Whether a rule files into this folder or label: deleting the mailbox deletes the rule. */
export function filesInto(rule: Pick<Rule, 'target'>, mailboxId: string): boolean {
	return (rule.target.kind === 'folder' || rule.target.kind === 'label') && rule.target.mailboxId === mailboxId;
}
