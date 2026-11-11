/**
 * A rule matches mail exactly: by sender, recipient, subject, body, size or
 * attachment, and files it: into a folder, under a label, read, flagged or
 * in Trash. Rules once also took a plain-English condition that Jev judged,
 * and could put mail in an Inbox tab. Both are gone: the tabs belong to
 * Jev and to sender pins. A stored rule that relied on either is listed for
 * its owner (see `RuleAttention`).
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
 *   longer do, and it couldn't be turned into a sender pin. It is switched
 *   off too: with its only action gone there is nothing for it to do.
 * - `tab_removed`: it put mail in a tab beside something else (a label,
 *   say). The tab part is gone and the rest still runs; this is only a note
 *   for the owner, who can dismiss it.
 */
export type RuleAttention = 'jev_condition' | 'tab_rule' | 'tab_removed';

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

export interface Rule {
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
}

/**
 * A condition is usable only if it would actually constrain matching. An
 * empty text value is dropped (the Sieve compiler does the same) so a
 * half-finished rule never becomes match-everything.
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
export function hasOnlyKnownConditions(rule: Pick<Rule, 'conditions'>): boolean {
	return Array.isArray(rule.conditions) && rule.conditions.every((c) => CONDITION_FIELDS.has(c?.field));
}

/** Whether the rule is switched off until its owner rewrites it. */
export function needsRewrite(rule: Pick<Rule, 'attention'>): boolean {
	return rule.attention === 'jev_condition' || rule.attention === 'tab_rule';
}

/**
 * Whether a rule may act on mail at all: switched on, not waiting for its
 * owner to rewrite it (even if someone switched it back on without doing
 * so), and made only of conditions this version can match.
 */
export function isRunnable(rule: Rule): boolean {
	return rule.enabled && !needsRewrite(rule) && hasOnlyKnownConditions(rule);
}

/** Whether one condition holds, given whether it matched: NOT flips it. */
export function conditionHolds(c: RuleCondition, matched: boolean): boolean {
	return c.negate ? !matched : matched;
}

/** Whether a rule matches, given whether each usable condition matched. */
export function ruleHolds(
	rule: Pick<Rule, 'conditions' | 'logic'>,
	matches: (c: RuleCondition) => boolean
): boolean {
	if (!hasOnlyKnownConditions(rule)) return false; // never on part of a rule
	const conds = rule.conditions.filter(isUsableCondition);
	if (conds.length === 0) return false; // never match-everything
	const results = conds.map((c) => conditionHolds(c, matches(c)));
	return rule.logic === 'anyof' ? results.some(Boolean) : results.every(Boolean);
}
