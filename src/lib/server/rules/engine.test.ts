import { describe, expect, it } from 'vitest';
import type { Email } from '$lib/jmap/types';
import type { Rule, RuleCondition } from '$lib/types/rules';
import { evaluateRulesForEmail, outcomeToUpdate, ruleContext, updatesForEmails, type RuleActionCtx } from './engine';

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
	return {
		id,
		name: id,
		enabled: true,
		logic: 'allof',
		conditions: [fromShop],
		target: { kind: 'none' },
		markRead: false,
		star: false,
		stop: false,
		position: 0,
		createdAt: 0,
		updatedAt: 0,
		...overrides
	};
}
const folder = (mailboxId: string) => ({ target: { kind: 'folder' as const, mailboxId } });
const label = (mailboxId: string) => ({ target: { kind: 'label' as const, mailboxId } });

const box = (id: string, role: string | null, parentId: string | null = null) => ({ id, name: id, role, parentId });
const ctx: RuleActionCtx = ruleContext([
	box('inbox', 'inbox'),
	box('trash', 'trash'),
	box('arch', 'archive'),
	box('junk', 'junk'),
	box('finance', null),
	box('receipts', null),
	box('projects', null),
	box('Labels', null),
	box('work', null, 'Labels'),
	box('bills', null, 'Labels')
]);

const run = (rules: Rule[], e = email()) => evaluateRulesForEmail(e, rules, ctx, '');

describe('evaluateRulesForEmail', () => {
	it('adds up labels', () => {
		const outcome = run([rule('a', label('work')), rule('b', label('bills'))]);
		expect(outcome.firedRuleIds).toEqual(['a', 'b']);
		expect([...outcome.labels]).toEqual(['work', 'bills']);
		expect(outcome.moveTo).toBeNull();
	});

	it('lets the first rule that moves a message decide its folder', () => {
		const outcome = run([rule('label', label('work')), rule('first', folder('finance')), rule('second', folder('receipts'))]);
		expect(outcome.firedRuleIds).toEqual(['label', 'first', 'second']);
		expect([...outcome.labels]).toEqual(['work']);
		expect(outcome.moveTo).toBe('finance');
	});

	it('moves to Trash, Archive or Junk by role', () => {
		for (const [kind, id] of [['trash', 'trash'], ['archive', 'arch'], ['junk', 'junk']] as const) {
			const outcome = run([rule(kind, { target: { kind } })]);
			expect(outcome.moveTo).toBe(id);
			expect(outcome.labels.size).toBe(0);
		}
	});

	it('stops processing where a rule says so, after its own actions', () => {
		const stop = rule('stop', { conditions: [subjectInvoice], markRead: true, stop: true });
		const later = rule('later', folder('finance'));
		const outcome = run([stop, later]);
		expect(outcome.firedRuleIds).toEqual(['stop']);
		expect(outcome.keywords).toEqual({ $seen: true });
		expect(outcome.moveTo).toBeNull();
		// A rule that stops only on the mail it matches.
		expect(run([{ ...stop, conditions: [{ ...subjectInvoice, value: 'receipt' }] }, later]).firedRuleIds).toEqual(['later']);
	});

	it('marks read and stars', () => {
		const e = email();
		const outcome = run([rule('read', { markRead: true }), rule('star', { star: true })], e);
		expect(outcomeToUpdate(e, outcome, ctx.mailboxes)).toEqual({ 'keywords/$seen': true, 'keywords/$flagged': true });
	});

	it('skips a target that no longer exists, so a later move decides', () => {
		const outcome = run([rule('gone', folder('deleted')), rule('label', label('deleted-label')), rule('next', folder('finance'))]);
		expect(outcome.moveTo).toBe('finance');
		expect(outcome.labels.size).toBe(0);
		// No Junk on the account: nothing moves.
		const noJunk = { ...ctx, junkId: undefined };
		expect(evaluateRulesForEmail(email(), [rule('junk', { target: { kind: 'junk' } })], noJunk, '').moveTo).toBeNull();
	});
});

describe('what a rule’s move writes', () => {
	it('takes the message out of every folder it is in, not only the Inbox, and keeps its labels', () => {
		const e = email({ mailboxIds: { inbox: true, projects: true, work: true } });
		const { update } = updatesForEmails([e], [rule('file', folder('finance'))], ctx);
		expect(update).toEqual({ e1: { mailboxIds: { finance: true, work: true } } });
	});

	it('adds a label and leaves the folders alone', () => {
		const e = email({ mailboxIds: { inbox: true, projects: true } });
		const { update } = updatesForEmails([e], [rule('tag', label('bills'))], ctx);
		expect(update).toEqual({ e1: { mailboxIds: { inbox: true, projects: true, bills: true } } });
	});

	it('writes nothing for a message already where the rules put it', () => {
		const e = email({ mailboxIds: { finance: true, work: true } });
		expect(updatesForEmails([e], [rule('file', folder('finance')), rule('tag', label('work'))], ctx).update).toEqual({});
	});
});

describe('rules that may not run', () => {
	// What the upgrade leaves of "from the shop AND Jev says it's an invoice":
	// the exact part, flagged. Here someone has switched it back on unfixed.
	const flagged = rule('flagged', { ...folder('finance'), attention: 'jev_condition', enabled: true });
	// The same rule as it was stored before: the Jev condition still in it.
	const unconverted = rule('old', { ...folder('finance'), conditions: [fromShop, jev('j')] });

	it('never fire in the engine, though the mail matches their exact conditions', () => {
		for (const r of [
			flagged,
			{ ...flagged, attention: 'tab_rule' as const },
			{ ...flagged, attention: 'tab_pinned' as const },
			unconverted,
			{ ...unconverted, logic: 'anyof' as const },
			rule('off', { ...folder('finance'), enabled: false })
		]) {
			expect(run([r]).firedRuleIds).toEqual([]);
			expect(updatesForEmails([email()], [r], ctx)).toEqual({ matched: 0, update: {} });
		}
		// The rule without the flag is the control: this mail does match it.
		expect(run([{ ...flagged, attention: undefined }]).firedRuleIds).toEqual(['flagged']);
		// A note about a rule that still runs doesn't stop it.
		expect(run([{ ...flagged, attention: 'tab_removed' }]).firedRuleIds).toEqual(['flagged']);
		expect(run([{ ...flagged, attention: 'split' }]).firedRuleIds).toEqual(['flagged']);
	});

	it('don’t stop the rules after them', () => {
		const stopper = { ...flagged, stop: true };
		const later = rule('later', { markRead: true });
		expect(run([stopper, later]).firedRuleIds).toEqual(['later']);
	});
});
