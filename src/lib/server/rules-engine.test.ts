import { describe, expect, it } from 'vitest';
import type { Email } from '$lib/jmap/types';
import type { Rule, RuleCondition } from '$lib/types/rules';
import { evaluateRulesForEmail, outcomeToUpdate, updatesForEmails, type RuleActionCtx } from './rules-engine';
import type { RuleAction } from '$lib/types/rules';
import { buildJmapFilter } from './rules';
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

/** A condition Jev judged, as a rule stored before rules became exact-match only still has it. */
const jev = (id: string, value = 'it is an invoice'): RuleCondition =>
	({ id, field: 'jev', op: 'contains', value, negate: false }) as unknown as RuleCondition;
const subjectInvoice: RuleCondition = { id: 's', field: 'subject', op: 'contains', value: 'invoice', negate: false };
const fromShop: RuleCondition = { id: 'f', field: 'from', op: 'contains', value: 'shop.example', negate: false };

function rule(id: string, overrides: Partial<Rule>): Rule {
	return { id, name: id, enabled: true, logic: 'allof', conditions: [], actions: [], createdAt: 0, ...overrides };
}

const ctx: RuleActionCtx = {
	inboxId: 'inbox',
	trashId: 'trash',
	validMailboxIds: new Set(['inbox', 'trash', 'finance', 'archive'])
};

describe('evaluateRulesForEmail', () => {
	it('keeps rule order and Stop processing', () => {
		const stop = rule('stop', { conditions: [subjectInvoice], actions: [{ type: 'markRead' }, { type: 'stopProcessing' }] });
		const later = rule('later', { conditions: [fromShop], actions: [{ type: 'moveToFolder', value: 'archive' }] });
		const outcome = evaluateRulesForEmail(email(), [stop, later], ctx, '');
		expect(outcome.firedRuleIds).toEqual(['stop']);
		expect(outcome.keywords).toEqual({ $seen: true });
		expect(outcome.addMailboxIds.size).toBe(0);
	});

	it('moves to Trash when a rule says Delete', () => {
		const trashIt = rule('trash', { conditions: [fromShop], actions: [{ type: 'delete' }] });
		const outcome = evaluateRulesForEmail(email(), [trashIt], ctx, '');
		expect([...outcome.addMailboxIds]).toEqual(['trash']);
		expect([...outcome.removeMailboxIds]).toEqual(['inbox']);
	});

	it('never puts mail in an Inbox tab: an old tab action does nothing, and the rule’s other actions still run', () => {
		// As a browser tab left open across the upgrade would still send it.
		const toUpdates = { type: 'setCategory', value: 'updates' } as unknown as RuleAction;
		const tab = rule('tab', { conditions: [fromShop], actions: [toUpdates, { type: 'markRead' }] });
		const e = email({ keywords: { $cat_promotions: true } });
		const outcome = evaluateRulesForEmail(e, [tab], ctx, '');
		expect(outcome.firedRuleIds).toEqual(['tab']);
		expect(outcomeToUpdate(e, outcome)).toEqual({ 'keywords/$seen': true });

		const script = compileRulesToSieve([tab], buildSieveContext([]));
		expect(script).toContain('addflag "\\\\Seen";');
		expect(script).not.toContain('$cat_');
	});
});

describe('rules that may not run', () => {
	const move = [{ type: 'moveToFolder' as const, value: 'finance' }];
	// What the upgrade leaves of "from the shop AND Jev says it's an invoice":
	// the exact part, flagged. Here someone has switched it back on unfixed.
	const flagged = rule('flagged', { conditions: [fromShop], actions: move, attention: 'jev_condition', enabled: true });
	// The same rule as an old browser tab would save it: the Jev condition still in it.
	const unconverted = rule('old', { conditions: [fromShop, jev('j')], actions: move });
	const mailboxes = [{ id: 'finance', name: 'Finance', role: null, parentId: null, sortOrder: 0, totalEmails: 0, unreadEmails: 0 }];

	it('never fire in the engine, though the mail matches their exact conditions', () => {
		for (const r of [flagged, unconverted, { ...unconverted, logic: 'anyof' as const }]) {
			expect(evaluateRulesForEmail(email(), [r], ctx, '').firedRuleIds).toEqual([]);
			expect(updatesForEmails([email()], [r], ctx)).toEqual({ matched: 0, update: {} });
		}
		// The rule without the flag is the control: this mail does match it.
		expect(evaluateRulesForEmail(email(), [{ ...flagged, attention: undefined }], ctx, '').firedRuleIds).toEqual(['flagged']);
	});

	it('don’t stop the rules after them', () => {
		const stopper = { ...flagged, actions: [{ type: 'stopProcessing' as const }] };
		const later = rule('later', { conditions: [fromShop], actions: [{ type: 'markRead' }] });
		expect(evaluateRulesForEmail(email(), [stopper, later], ctx, '').firedRuleIds).toEqual(['later']);
	});

	it('give no search filter, so the preview counts nothing for them', () => {
		expect(buildJmapFilter(flagged)).toBeNull();
		expect(buildJmapFilter(unconverted)).toBeNull();
		expect(buildJmapFilter({ ...flagged, attention: undefined })).toEqual({ from: 'shop.example' });
	});

	it('are left out of Sieve rather than widened', () => {
		for (const r of [flagged, unconverted]) {
			const script = compileRulesToSieve([r], buildSieveContext(mailboxes));
			expect(script).not.toMatch(/^\s*fileinto /m);
			expect(script).not.toContain('if header');
		}
		expect(compileRulesToSieve([{ ...flagged, attention: undefined }], buildSieveContext(mailboxes))).toContain('fileinto "Finance";');
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

describe('buildJmapFilter negation', () => {
	const cond = (over: Partial<RuleCondition>): RuleCondition => ({
		id: 'c',
		field: 'subject',
		op: 'contains',
		value: 'hello',
		negate: false,
		...over
	});
	const only = (c: RuleCondition): Rule => ({
		id: 'r',
		name: 'r',
		enabled: true,
		logic: 'allof',
		conditions: [c],
		actions: [],
		createdAt: 0
	});

	it('reads NOT and "doesn\'t contain" as the engine does: together they cancel out', () => {
		const not = { operator: 'NOT', conditions: [{ subject: 'hello' }] };
		expect(buildJmapFilter(only(cond({ op: 'not_contains' })))).toEqual(not);
		expect(buildJmapFilter(only(cond({ negate: true })))).toEqual(not);
		expect(buildJmapFilter(only(cond({ op: 'not_contains', negate: true })))).toEqual({ subject: 'hello' });
	});

	it('ignores an operator left behind on Has attachment and Size, as the engine does', () => {
		expect(buildJmapFilter(only(cond({ field: 'hasAttachment', op: 'not_contains', value: '' })))).toEqual({
			hasAttachment: true
		});
		expect(buildJmapFilter(only(cond({ field: 'size', op: 'not_contains', value: '100' })))).toEqual({
			minSize: 102400
		});
		expect(buildJmapFilter(only(cond({ field: 'hasAttachment', negate: true, value: '' })))).toEqual({
			operator: 'NOT',
			conditions: [{ hasAttachment: true }]
		});
	});
});
