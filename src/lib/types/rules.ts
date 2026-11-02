import { isInboxCategory } from './categories';

/**
 * `jev` is a condition Jev judges: `value` is a plain-English statement
 * about the email ("it's an invoice or a request for payment") and
 * `strictness` how sure Jev must be. The others match text exactly.
 */
export type RuleConditionField = 'from' | 'to' | 'subject' | 'body' | 'size' | 'hasAttachment' | 'jev';
export type RuleConditionOp = 'contains' | 'not_contains' | 'is' | 'starts_with' | 'ends_with';
export type RuleLogic = 'allof' | 'anyof';
export type JevStrictness = 'loose' | 'normal' | 'strict';

export interface RuleCondition {
	id: string;
	field: RuleConditionField;
	op: RuleConditionOp;
	value: string;
	negate: boolean;
	/** For `jev` conditions; `normal` when unset. */
	strictness?: JevStrictness;
}

export type RuleActionType =
	| 'moveToFolder'
	| 'applyLabel'
	| 'markRead'
	| 'markImportant'
	| 'setCategory'
	| 'delete'
	| 'stopProcessing';

export interface RuleAction {
	type: RuleActionType;
	/** Mailbox id for folder/label actions; the tab for `setCategory`. */
	value?: string;
}

export interface Rule {
	id: string;
	name: string;
	enabled: boolean;
	logic: RuleLogic;
	conditions: RuleCondition[];
	actions: RuleAction[];
	createdAt: number;
}

/**
 * The probability Jev must give a statement for a `jev` condition to hold.
 * See JEV_PLAN.md, decision 6.
 */
export const JEV_STRICTNESS: Record<JevStrictness, { label: string; threshold: number }> = {
	loose: { label: 'Loose', threshold: 0.6 },
	normal: { label: 'Normal', threshold: 0.8 },
	strict: { label: 'Strict', threshold: 0.95 }
};

export function jevThreshold(c: RuleCondition): number {
	return JEV_STRICTNESS[c.strictness ?? 'normal']?.threshold ?? JEV_STRICTNESS.normal.threshold;
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
		case 'jev':
			return c.value.trim().length > 0;
		case 'size':
			return Number.isFinite(parseInt(c.value, 10));
		case 'hasAttachment':
			return true;
		default:
			return false;
	}
}

export function hasJevCondition(rule: Pick<Rule, 'conditions'>): boolean {
	return rule.conditions.some((c) => c.field === 'jev' && isUsableCondition(c));
}

/**
 * Whether one condition holds, given its raw value: a boolean for an exact
 * condition, Jev's probability for a `jev` one, or undefined when unknown.
 * Unknown never holds — not even negated — so a rule can't fire on an
 * answer Jev never gave.
 */
export function conditionHolds(c: RuleCondition, value: boolean | number | undefined): boolean {
	if (value === undefined) return false;
	const result = typeof value === 'number' ? value >= jevThreshold(c) : value;
	return c.negate ? !result : result;
}

/**
 * Whether a rule matches, given each usable condition's raw value. Shared by
 * the engine and the rules editor's test view so both decide alike.
 */
export function ruleHolds(
	rule: Pick<Rule, 'conditions' | 'logic'>,
	valueOf: (c: RuleCondition) => boolean | number | undefined
): boolean {
	const conds = rule.conditions.filter(isUsableCondition);
	if (conds.length === 0) return false; // never match-everything
	const results = conds.map((c) => conditionHolds(c, valueOf(c)));
	return rule.logic === 'anyof' ? results.some(Boolean) : results.every(Boolean);
}

/**
 * The actions a rule may take. A rule with a Jev condition never deletes:
 * Trash empties itself, so a misjudged delete would become permanent.
 */
export function effectiveActions(rule: Rule): RuleAction[] {
	const actions = hasJevCondition(rule) ? rule.actions.filter((a) => a.type !== 'delete') : rule.actions;
	return actions.filter((a) => a.type !== 'setCategory' || isInboxCategory(a.value));
}

/**
 * Mailbox roles a rule Jev judges may never move mail into, for the reason
 * it never deletes: Trash empties itself, and Junk is as good as deleted for
 * mail nobody reads. The editor hides them as targets; the worker drops them.
 */
export const JEV_OFF_LIMITS_ROLES: ReadonlySet<string> = new Set(['trash', 'junk']);

/**
 * The rule as the Jev worker may run it: a rule Jev judges loses any folder
 * or label action aimed at one of `offLimits` (the Trash and Junk ids). Other
 * rules, and rules with nothing to drop, come back as they are.
 */
export function withoutOffLimitsTargets(rule: Rule, offLimits: ReadonlySet<string>): Rule {
	if (!hasJevCondition(rule)) return rule;
	const actions = rule.actions.filter(
		(a) => !((a.type === 'moveToFolder' || a.type === 'applyLabel') && a.value && offLimits.has(a.value))
	);
	return actions.length === rule.actions.length ? rule : { ...rule, actions };
}
