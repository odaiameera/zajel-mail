import { describe, expect, it } from 'vitest';
import type { Email } from '$lib/jmap/types';
import type { Rule, RuleCondition } from '$lib/types/rules';
import { evaluateRulesForEmail, jevConditionsToAsk, outcomeToUpdate, type RuleActionCtx } from './rules-engine';
import { buildJmapFilter, exactPartFilter } from './rules';
import { buildSieveContext, compileRulesToSieve } from './sieve';

function email(overrides: Partial<Email> = {}): Email {
	return {
		id: 'e1',
		blobId: 'b1',
		threadId: 't1',
		mailboxIds: { inbox: true },
		from: [{ name: 'Shop', email: 'billing@shop.example' }],
		to: [{ name: null, email: 'me@example.test' }],
		cc: null,
		subject: 'Your October invoice',
		receivedAt: '2026-10-18T09:00:00Z',
		size: 2000,
		preview: '',
		keywords: {},
		hasAttachment: false,
		...overrides
	};
}

const jev = (id: string, value = 'it is an invoice', extra: Partial<RuleCondition> = {}): RuleCondition => ({
	id,
	field: 'jev',
	op: 'contains',
	value,
	negate: false,
	...extra
});
const fromShop: RuleCondition = { id: 'f', field: 'from', op: 'contains', value: 'shop.example', negate: false };
const fromBank: RuleCondition = { id: 'b', field: 'from', op: 'contains', value: 'bank.example', negate: false };

function rule(id: string, overrides: Partial<Rule>): Rule {
	return { id, name: id, enabled: true, logic: 'allof', conditions: [], actions: [], createdAt: 0, ...overrides };
}

const ctx: RuleActionCtx = {
	inboxId: 'inbox',
	trashId: 'trash',
	validMailboxIds: new Set(['inbox', 'trash', 'finance', 'archive'])
};

describe('evaluateRulesForEmail with Jev conditions', () => {
	const invoices = rule('invoices', {
		conditions: [jev('j1')],
		actions: [{ type: 'applyLabel', value: 'finance' }, { type: 'delete' }]
	});

	it('fires when Jev is sure enough, and never deletes', () => {
		const outcome = evaluateRulesForEmail(email(), [invoices], ctx, '', new Map([['j1', 0.93]]));
		expect(outcome.firedRuleIds).toEqual(['invoices']);
		expect([...outcome.addMailboxIds]).toEqual(['finance']);
		expect(outcome.removeMailboxIds.size).toBe(0);
	});

	it('doesn’t fire below the strictness, or without an answer', () => {
		expect(evaluateRulesForEmail(email(), [invoices], ctx, '', new Map([['j1', 0.7]])).firedRuleIds).toEqual([]);
		expect(evaluateRulesForEmail(email(), [invoices], ctx, '').firedRuleIds).toEqual([]);
	});

	it('keeps rule order and Stop processing across exact and Jev rules', () => {
		const stop = rule('stop', { conditions: [jev('j1')], actions: [{ type: 'markRead' }, { type: 'stopProcessing' }] });
		const later = rule('later', { conditions: [fromShop], actions: [{ type: 'moveToFolder', value: 'archive' }] });
		const outcome = evaluateRulesForEmail(email(), [stop, later], ctx, '', new Map([['j1', 0.9]]));
		expect(outcome.firedRuleIds).toEqual(['stop']);
		expect(outcome.keywords).toEqual({ $seen: true });
		expect(outcome.addMailboxIds.size).toBe(0);
	});

	it('moves to an Inbox tab, clearing the others', () => {
		const tab = rule('tab', { conditions: [fromShop], actions: [{ type: 'setCategory', value: 'updates' }] });
		const e = email({ keywords: { $cat_promotions: true } });
		const outcome = evaluateRulesForEmail(e, [tab], ctx, '');
		expect(outcome.category).toBe('updates');
		expect(outcomeToUpdate(e, outcome)).toEqual({
			'keywords/$cat_updates': true,
			'keywords/$cat_promotions': false
		});
	});
});

describe('jevConditionsToAsk', () => {
	it('skips conditions that can’t change the outcome', () => {
		const rules = [
			// All-of with a failing exact condition: can't match.
			rule('a', { conditions: [fromBank, jev('j-a')] }),
			// All-of with a holding one: Jev decides.
			rule('b', { conditions: [fromShop, jev('j-b')] }),
			// Any-of with a holding one: matches already.
			rule('c', { logic: 'anyof', conditions: [fromShop, jev('j-c')] }),
			// Any-of with none holding: Jev decides.
			rule('d', { logic: 'anyof', conditions: [fromBank, jev('j-d')] }),
			// No Jev condition at all.
			rule('e', { conditions: [fromShop] })
		];
		expect(jevConditionsToAsk(email(), rules, '').map((c) => c.id)).toEqual(['j-b', 'j-d']);
	});
});

describe('guards against dropping a Jev condition', () => {
	const mixed = rule('mixed', {
		name: 'Shop receipts',
		conditions: [fromShop, jev('j')],
		actions: [{ type: 'moveToFolder', value: 'finance' }]
	});

	it('gives no search filter for the whole rule, only for its exact part', () => {
		expect(buildJmapFilter(mixed)).toBeNull();
		expect(exactPartFilter(mixed)).toEqual({ from: 'shop.example' });
		expect(exactPartFilter({ ...mixed, logic: 'anyof' })).toBeNull();
	});

	it('leaves the rule out of Sieve rather than widening it', () => {
		const mailboxes = [{ id: 'finance', name: 'Finance', role: null, parentId: null, sortOrder: 0, totalEmails: 0, unreadEmails: 0 }];
		const script = compileRulesToSieve([mixed], buildSieveContext(mailboxes));
		expect(script).toContain('has a Jev condition, applied by the app');
		expect(script).not.toMatch(/^\s*fileinto /m);
		expect(script).not.toContain('if header');
	});

	it('compiles a tab action to keyword flags', () => {
		const tab = rule('tab', { conditions: [fromShop], actions: [{ type: 'setCategory', value: 'newsletters' }] });
		const script = compileRulesToSieve([tab], buildSieveContext([]));
		expect(script).toContain('removeflag ["$cat_updates", "$cat_newsletters", "$cat_promotions"]; addflag "$cat_newsletters";');
	});
});

describe('Move to trash in Sieve', () => {
	const trashIt = rule('trash', { conditions: [fromShop], actions: [{ type: 'delete' }, { type: 'markRead' }] });
	const box = (id: string, name: string, role: string | null) => ({
		id,
		name,
		role,
		parentId: null,
		sortOrder: 0,
		totalEmails: 0,
		unreadEmails: 0
	});

	it('files the message into Trash instead of discarding it', () => {
		const script = compileRulesToSieve([trashIt], buildSieveContext([box('in', 'Inbox', 'inbox'), box('tr', 'Deleted Items', 'trash')]));
		expect(script).not.toContain('discard');
		expect(script).toContain('fileinto "Deleted Items";');
		// Like the app's own engine, it doesn't stop the rule's later actions.
		expect(script).toContain('addflag "\\\\Seen";');
		expect(script).not.toContain('stop;');
	});

	it('drops the action when the account has no Trash', () => {
		const script = compileRulesToSieve([trashIt], buildSieveContext([box('in', 'Inbox', 'inbox')]));
		expect(script).not.toContain('discard');
		expect(script).not.toMatch(/^\s*fileinto /m);
	});
});
