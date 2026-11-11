import { describe, expect, it } from 'vitest';
import {
	conditionHolds,
	hasOnlyKnownConditions,
	isRunnable,
	isUsableCondition,
	mailboxDeleteRulesNote,
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
		target: { kind: 'label', mailboxId: 'lbl' },
		markRead: false,
		star: false,
		stop: false,
		position: 0,
		createdAt: 0,
		updatedAt: 0,
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
		// Rewritten, or (for one that became a pin) dismissed, but never run.
		for (const attention of ['jev_condition', 'tab_rule', 'tab_pinned'] as const) {
			const flagged = rule({ attention, enabled: true });
			expect(needsRewrite(flagged)).toBe(true);
			expect(isRunnable(flagged)).toBe(false);
		}
	});

	it('is still a rule that only lost its tab: that flag is a note, and the rest runs', () => {
		const noted = rule({ attention: 'tab_removed' });
		expect(needsRewrite(noted)).toBe(false);
		expect(isRunnable(noted)).toBe(true);
	});

	it('is never a rule with a condition this version doesn’t have', () => {
		expect(hasOnlyKnownConditions(rule({ conditions: [from(), jev] }))).toBe(false);
		expect(isRunnable(rule({ conditions: [from(), jev] }))).toBe(false);
		// Rules are stored as a browser sent them: not even a list of conditions is a given.
		expect(isRunnable(rule({ conditions: undefined as unknown as RuleCondition[] }))).toBe(false);
		// Nor that an entry is a rule.
		expect(isRunnable(null as unknown as Rule)).toBe(false);
		expect(isRunnable('rule' as unknown as Rule)).toBe(false);
	});
});

describe('mailboxDeleteRulesNote', () => {
	const L = { kind: 'label' as const, mailboxId: 'L' };
	const r = (over: Partial<Rule> = {}) => ({ target: L, markRead: false, star: false, stop: false, ...over });

	it('names the rules deleted and the rules kept, leaving out a sentence whose count is 0', () => {
		expect(mailboxDeleteRulesNote([r(), r({ markRead: true }), r({ stop: true })], 'L')).toBe(
			'This also deletes 1 rule that files into it. 2 other rules will keep marking mail as read (or starring, or stopping later rules) without filing it.'
		);
		expect(mailboxDeleteRulesNote([r(), r()], 'L')).toBe('This also deletes 2 rules that file into it.');
		expect(mailboxDeleteRulesNote([r({ star: true })], 'L')).toBe(
			'1 other rule will keep marking mail as read (or starring, or stopping later rules) without filing it.'
		);
		expect(mailboxDeleteRulesNote([r({ target: { kind: 'folder', mailboxId: 'X' } }), r({ target: { kind: 'none' }, stop: true })], 'L')).toBe('');
	});
});
