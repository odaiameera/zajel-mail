import { describe, expect, it } from 'vitest';
import {
	conditionHolds,
	effectiveActions,
	hasOnlyKnownConditions,
	isRunnable,
	isUsableCondition,
	needsRewrite,
	ruleHolds,
	type Rule,
	type RuleCondition
} from './rules';

const from = (overrides: Partial<RuleCondition> = {}): RuleCondition => ({
	id: 'f1',
	field: 'from',
	op: 'contains',
	value: 'shop.example',
	negate: false,
	...overrides
});

/** A condition Jev judged, as rules stored before they became exact-match only still have it. */
const jev = { id: 'j1', field: 'jev', op: 'contains', value: 'it is an invoice', negate: false } as unknown as RuleCondition;

function rule(overrides: Partial<Rule> = {}): Rule {
	return {
		id: 'r1',
		name: 'Invoices',
		enabled: true,
		logic: 'allof',
		conditions: [from()],
		actions: [{ type: 'applyLabel', value: 'lbl' }],
		createdAt: 0,
		...overrides
	};
}

describe('conditions', () => {
	it('need a value to count, except Has attachment', () => {
		expect(isUsableCondition(from())).toBe(true);
		expect(isUsableCondition(from({ value: '  ' }))).toBe(false);
		expect(isUsableCondition(from({ field: 'size', value: 'big' }))).toBe(false);
		expect(isUsableCondition(from({ field: 'hasAttachment', value: '' }))).toBe(true);
		// A kind of condition rules no longer have is not one to match on.
		expect(isUsableCondition(jev)).toBe(false);
	});

	it('are flipped by NOT', () => {
		expect(conditionHolds(from(), true)).toBe(true);
		expect(conditionHolds(from({ negate: true }), true)).toBe(false);
		expect(conditionHolds(from({ negate: true }), false)).toBe(true);
	});
});

describe('ruleHolds', () => {
	const subject = from({ id: 's1', field: 'subject', value: 'invoice' });
	const both = rule({ conditions: [from(), subject] });

	it('combines conditions with the rule’s logic', () => {
		expect(ruleHolds(both, () => true)).toBe(true);
		expect(ruleHolds(both, (c) => c.id === 'f1')).toBe(false);
		expect(ruleHolds({ ...both, logic: 'anyof' }, (c) => c.id === 'f1')).toBe(true);
		expect(ruleHolds({ ...both, logic: 'anyof' }, () => false)).toBe(false);
	});

	it('never matches everything', () => {
		expect(ruleHolds(rule({ conditions: [from({ value: '' })] }), () => true)).toBe(false);
		expect(ruleHolds(rule({ conditions: [] }), () => true)).toBe(false);
	});

	it('never matches on part of a rule: one with a condition it can’t read doesn’t hold at all', () => {
		// "From the shop AND Jev says it's an invoice" must not become "from the shop".
		const mixed = rule({ conditions: [from(), jev] });
		expect(ruleHolds(mixed, () => true)).toBe(false);
		expect(ruleHolds({ ...mixed, logic: 'anyof' }, () => true)).toBe(false);
	});
});

describe('isRunnable', () => {
	it('is a rule that is switched on', () => {
		expect(isRunnable(rule())).toBe(true);
		expect(isRunnable(rule({ enabled: false }))).toBe(false);
	});

	it('is never a rule waiting to be rewritten, even switched back on', () => {
		const flagged = rule({ attention: 'jev_condition', enabled: true });
		expect(needsRewrite(flagged)).toBe(true);
		expect(isRunnable(flagged)).toBe(false);
	});

	it('is never a rule with a condition this version doesn’t have', () => {
		expect(hasOnlyKnownConditions(rule({ conditions: [from(), jev] }))).toBe(false);
		expect(isRunnable(rule({ conditions: [from(), jev] }))).toBe(false);
		// Rules are stored as a browser sent them: not even a list of conditions is a given.
		expect(isRunnable(rule({ conditions: undefined as unknown as RuleCondition[] }))).toBe(false);
	});
});

describe('effectiveActions', () => {
	it('keeps Delete, which no rule is barred from now', () => {
		const actions = [{ type: 'delete' as const }, { type: 'markRead' as const }];
		expect(effectiveActions(rule({ actions }))).toEqual(actions);
	});

	it('drops a tab action with no tab picked', () => {
		const actions = [{ type: 'setCategory' as const, value: '' }, { type: 'setCategory' as const, value: 'updates' }];
		expect(effectiveActions(rule({ actions }))).toEqual([{ type: 'setCategory', value: 'updates' }]);
	});
});
