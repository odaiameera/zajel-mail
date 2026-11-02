import { describe, expect, it } from 'vitest';
import {
	conditionHolds,
	effectiveActions,
	hasJevCondition,
	isUsableCondition,
	jevThreshold,
	ruleHolds,
	withoutOffLimitsTargets,
	type Rule,
	type RuleCondition
} from './rules';

const jev = (overrides: Partial<RuleCondition> = {}): RuleCondition => ({
	id: 'j1',
	field: 'jev',
	op: 'contains',
	value: 'it is an invoice',
	negate: false,
	...overrides
});
const from = (overrides: Partial<RuleCondition> = {}): RuleCondition => ({
	id: 'f1',
	field: 'from',
	op: 'contains',
	value: 'shop.example',
	negate: false,
	...overrides
});

function rule(overrides: Partial<Rule> = {}): Rule {
	return {
		id: 'r1',
		name: 'Invoices',
		enabled: true,
		logic: 'allof',
		conditions: [jev()],
		actions: [{ type: 'applyLabel', value: 'lbl' }],
		createdAt: 0,
		...overrides
	};
}

describe('Jev conditions', () => {
	it('need a statement to count', () => {
		expect(isUsableCondition(jev())).toBe(true);
		expect(isUsableCondition(jev({ value: '  ' }))).toBe(false);
		expect(hasJevCondition(rule({ conditions: [jev({ value: '' }), from()] }))).toBe(false);
	});

	it('hold when Jev is at least as sure as the strictness asks', () => {
		expect(jevThreshold(jev())).toBe(0.8);
		expect(jevThreshold(jev({ strictness: 'loose' }))).toBe(0.6);
		expect(jevThreshold(jev({ strictness: 'strict' }))).toBe(0.95);

		expect(conditionHolds(jev(), 0.8)).toBe(true);
		expect(conditionHolds(jev(), 0.79)).toBe(false);
		expect(conditionHolds(jev({ strictness: 'strict' }), 0.9)).toBe(false);
		expect(conditionHolds(jev({ negate: true }), 0.1)).toBe(true);
	});

	it('never hold on an answer Jev didn’t give, negated or not', () => {
		expect(conditionHolds(jev(), undefined)).toBe(false);
		expect(conditionHolds(jev({ negate: true }), undefined)).toBe(false);
	});
});

describe('ruleHolds', () => {
	it('combines exact and Jev conditions with the rule’s logic', () => {
		const both = rule({ conditions: [from(), jev()] });
		expect(ruleHolds(both, (c) => (c.field === 'jev' ? 0.9 : true))).toBe(true);
		expect(ruleHolds(both, (c) => (c.field === 'jev' ? 0.9 : false))).toBe(false);
		expect(ruleHolds({ ...both, logic: 'anyof' }, (c) => (c.field === 'jev' ? 0.9 : false))).toBe(true);
		expect(ruleHolds({ ...both, logic: 'anyof' }, (c) => (c.field === 'jev' ? undefined : false))).toBe(false);
	});

	it('never matches everything', () => {
		expect(ruleHolds(rule({ conditions: [jev({ value: '' })] }), () => true)).toBe(false);
	});
});

describe('effectiveActions', () => {
	it('drops Delete from a rule Jev judges, and keeps it otherwise', () => {
		const actions = [{ type: 'delete' as const }, { type: 'markRead' as const }];
		expect(effectiveActions(rule({ actions }))).toEqual([{ type: 'markRead' }]);
		expect(effectiveActions(rule({ conditions: [from()], actions }))).toEqual(actions);
	});

	it('drops a tab action with no tab picked', () => {
		const actions = [{ type: 'setCategory' as const, value: '' }, { type: 'setCategory' as const, value: 'updates' }];
		expect(effectiveActions(rule({ actions }))).toEqual([{ type: 'setCategory', value: 'updates' }]);
	});
});

describe('withoutOffLimitsTargets', () => {
	const offLimits = new Set(['trash', 'junk']);

	it('drops Trash and Junk as targets from a rule Jev judges, keeping the rest', () => {
		const actions = [
			{ type: 'moveToFolder' as const, value: 'junk' },
			{ type: 'applyLabel' as const, value: 'trash' },
			{ type: 'moveToFolder' as const, value: 'receipts' },
			{ type: 'markRead' as const }
		];
		expect(withoutOffLimitsTargets(rule({ actions }), offLimits).actions).toEqual([
			{ type: 'moveToFolder', value: 'receipts' },
			{ type: 'markRead' }
		]);
	});

	it('leaves other rules, and rules with nothing to drop, as they are', () => {
		const exact = rule({ conditions: [from()], actions: [{ type: 'moveToFolder', value: 'trash' }] });
		expect(withoutOffLimitsTargets(exact, offLimits)).toBe(exact);
		const fine = rule();
		expect(withoutOffLimitsTargets(fine, offLimits)).toBe(fine);
	});
});
