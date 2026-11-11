import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Point the lazy SQLite singleton at a throwaway file before anything opens it.
process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'zajel-rules-upgrade-')), 'test.db');
vi.mock('$lib/server/log', () => ({ logEvent: vi.fn(), errorFields: (e: unknown) => ({ error: String(e) }) }));

import type { Cookies } from '@sveltejs/kit';
import type { Email } from '$lib/jmap/types';
import type { Rule } from '$lib/types/rules';
import { getDb } from './db/index';
import { runMigrations } from './db/migrate';
import { getPinCategory, listPins, setPin } from './db/queries/jev-learning';
import { getRules } from './db/queries/rules';
import { evaluateRulesForEmail } from './rules-engine';
import { saveRules } from './rules-store';
import { retireStoredJevConditions, retireStoredTabActions, upgradeRules } from './rules-upgrade';

const ME = 'me@example.test';
/** The linked-account row whose address is ME: pins are kept under it. */
const ACCT = 'acct-me';

/** Rules as an earlier version stored them, written straight to the table. */
function store(email: string, rules: unknown): void {
	getDb()
		.prepare(
			`INSERT INTO user_rules (user_email, rules_json) VALUES (?, ?)
			 ON CONFLICT (user_email) DO UPDATE SET rules_json = excluded.rules_json`
		)
		.run(email, typeof rules === 'string' ? rules : JSON.stringify(rules));
}
const stored = (email: string) =>
	(getDb().prepare('SELECT rules_json FROM user_rules WHERE user_email = ?').get(email) as { rules_json: string }).rules_json;

/** Run a data step as a fresh start of the app would: by forgetting it ran, and migrating. */
function rerunStep(name: string): void {
	getDb().prepare('DELETE FROM _migrations WHERE name = ?').run(name);
	runMigrations();
}

const fromShop = { id: 'f1', field: 'from', op: 'contains', value: 'shop.example', negate: false };
const jevInvoice = { id: 'j1', field: 'jev', op: 'contains', value: 'it’s an invoice or a receipt', negate: false, strictness: 'strict' };
const toReceipts = [{ type: 'moveToFolder', value: 'receipts' }];

const rule = (id: string, over: Record<string, unknown> = {}) => ({
	id,
	name: id,
	enabled: true,
	logic: 'allof',
	conditions: [fromShop],
	actions: toReceipts,
	createdAt: 1,
	...over
});

// From the shop, but a newsletter, not an invoice.
const shopNewsletter = {
	id: 'e1',
	mailboxIds: { inbox: true },
	from: [{ name: 'Shop', email: 'news@shop.example' }],
	to: [{ name: null, email: ME }],
	subject: 'This week at the shop',
	size: 100,
	keywords: {},
	hasAttachment: false
} as unknown as Email;
const ctx = { inboxId: 'inbox', trashId: 'trash', validMailboxIds: new Set(['inbox', 'trash', 'receipts']) };

beforeAll(() => {
	runMigrations();
	getDb()
		.prepare(`INSERT INTO app_user (id, email, password_hash) VALUES ('user-1', 'u@example.test', 'x')`)
		.run();
	getDb()
		.prepare(
			`INSERT INTO mail_accounts (id, user_id, email, server_url, jmap_account_id, secret_enc)
			 VALUES (?, 'user-1', ?, 'https://mail.example', 'jmap-acc', 'x')`
		)
		.run(ACCT, ME);
});

beforeEach(() => {
	getDb().prepare('DELETE FROM user_rules').run();
	getDb().prepare('DELETE FROM jev_sender_pins').run();
});

describe('rules with a condition Jev judged', () => {
	it('are switched off and flagged, with the original kept to read', () => {
		const mixed = rule('mixed', { conditions: [fromShop, jevInvoice] });
		store(ME, [mixed]);

		rerunStep('data/rules_exact_only');

		const [after] = getRules(ME);
		expect(after).toMatchObject({ id: 'mixed', name: 'mixed', enabled: false, attention: 'jev_condition' });
		// The exact part is left as a start for rewriting it...
		expect(after.conditions).toEqual([fromShop]);
		expect(after.actions).toEqual(toReceipts);
		// ...and the rule as it was, Jev's statement and strictness included.
		expect(after.legacy).toEqual({
			enabled: true,
			logic: 'allof',
			conditions: [fromShop, jevInvoice],
			actions: toReceipts
		});
	});

	it('are never widened: the rule doesn’t act on mail its exact part alone matches, even switched back on', () => {
		store(ME, [rule('mixed', { conditions: [fromShop, jevInvoice] })]);
		rerunStep('data/rules_exact_only');

		const [after] = getRules(ME);
		expect(evaluateRulesForEmail(shopNewsletter, [after], ctx, '').firedRuleIds).toEqual([]);
		expect(evaluateRulesForEmail(shopNewsletter, [{ ...after, enabled: true }], ctx, '').firedRuleIds).toEqual([]);
	});

	it('are flagged whether the Jev condition stood alone, was one of any, or the rule was already off', () => {
		store(ME, [
			rule('alone', { conditions: [jevInvoice] }),
			rule('any', { logic: 'anyof', conditions: [fromShop, jevInvoice] }),
			rule('off', { enabled: false, conditions: [jevInvoice] })
		]);
		rerunStep('data/rules_exact_only');

		const after = getRules(ME);
		expect(after.map((r) => [r.id, r.enabled, r.attention])).toEqual([
			['alone', false, 'jev_condition'],
			['any', false, 'jev_condition'],
			['off', false, 'jev_condition']
		]);
		expect(after[0].conditions).toEqual([]);
		expect(after[1].legacy).toMatchObject({ logic: 'anyof', enabled: true });
		expect(after[2].legacy).toMatchObject({ enabled: false });
	});

	it('leave exact rules, and the order of the rules, exactly as they were', () => {
		const before = [rule('first'), rule('jev', { conditions: [jevInvoice] }), rule('last', { enabled: false })];
		store(ME, before);
		rerunStep('data/rules_exact_only');

		const after = getRules(ME);
		expect(after.map((r) => r.id)).toEqual(['first', 'jev', 'last']);
		expect(after[0]).toEqual(before[0]);
		expect(after[2]).toEqual(before[2]);
	});

	it('only lose a Jev condition that had no statement: the engine always ignored those', () => {
		const blank = { ...jevInvoice, value: '  ' };
		store(ME, [rule('half', { conditions: [fromShop, blank] })]);
		rerunStep('data/rules_exact_only');

		// Still on, not flagged, and matching what it matched before.
		expect(getRules(ME)).toEqual([rule('half')]);
	});

	it('change nothing when the step runs again', () => {
		store(ME, [rule('exact'), rule('mixed', { conditions: [fromShop, jevInvoice] })]);
		store('other@example.test', [rule('untouched')]);
		rerunStep('data/rules_exact_only');
		const once = [stored(ME), stored('other@example.test')];
		expect(once[1]).toBe(JSON.stringify([rule('untouched')]));

		retireStoredJevConditions();
		rerunStep('data/rules_exact_only');
		expect([stored(ME), stored('other@example.test')]).toEqual(once);
	});

	it('runs once: a later start of the app doesn’t redo it', () => {
		runMigrations();
		// Written behind the app's back after the step ran: left as it is.
		const late = [rule('late', { conditions: [jevInvoice] })];
		store(ME, late);
		runMigrations();
		expect(stored(ME)).toBe(JSON.stringify(late));
		expect(
			getDb().prepare(`SELECT COUNT(*) AS n FROM _migrations WHERE name = 'data/rules_exact_only'`).get()
		).toEqual({ n: 1 });
	});

	it('leaves rows it can’t read alone', () => {
		store(ME, 'not json');
		store('other@example.test', '{"not":"a list"}');
		store('third@example.test', [null, 'text', rule('mixed', { conditions: [fromShop, jevInvoice] })]);
		rerunStep('data/rules_exact_only');

		expect(stored(ME)).toBe('not json');
		expect(stored('other@example.test')).toBe('{"not":"a list"}');
		const third = JSON.parse(stored('third@example.test'));
		expect(third.slice(0, 2)).toEqual([null, 'text']);
		expect(third[2]).toMatchObject({ enabled: false, attention: 'jev_condition' });
	});
});

describe('saving rules', () => {
	const cookies = { get: () => undefined, delete: () => {} } as unknown as Cookies;

	it('flags a rule an old browser tab sends with its Jev condition still in it', () => {
		const mixed = rule('mixed', { conditions: [fromShop, jevInvoice] });
		saveRules(ME, [rule('exact'), mixed] as unknown as Rule[], cookies);

		const after = getRules(ME);
		expect(after[0]).toEqual(rule('exact'));
		expect(after[1]).toMatchObject({ enabled: false, attention: 'jev_condition', conditions: [fromShop] });
		expect(after[1].legacy?.conditions).toEqual([fromShop, jevInvoice]);
	});

	it('keeps a rewritten rule as its owner saved it: no flag, switched on', () => {
		const [flagged] = upgradeRules([rule('mixed', { conditions: [fromShop, jevInvoice] })], null);
		const { attention: _attention, legacy: _legacy, ...rest } = flagged;
		const rewritten = { ...rest, enabled: true, conditions: [{ ...fromShop, id: 's1', field: 'subject', value: 'invoice' }] } as Rule;
		saveRules(ME, [rewritten], cookies);

		expect(getRules(ME)).toEqual([rewritten]);
		const invoice = { ...shopNewsletter, subject: 'Your invoice' } as Email;
		expect(evaluateRulesForEmail(invoice, getRules(ME), ctx, '').firedRuleIds).toEqual(['mixed']);
	});

	it('keeps a flagged rule flagged, with its first original, however often it is saved', () => {
		const flagged = upgradeRules([rule('mixed', { conditions: [fromShop, jevInvoice] })], null);
		saveRules(ME, flagged, cookies);
		saveRules(ME, getRules(ME), cookies);
		expect(getRules(ME)).toEqual(flagged);
	});
});

describe('rules that put mail in an Inbox tab', () => {
	const toTab = (tab: string) => ({ type: 'setCategory', value: tab });
	const from = (value: string, over: Record<string, unknown> = {}) => ({ id: 'f1', field: 'from', op: 'contains', value, negate: false, ...over });
	const label = { type: 'applyLabel', value: 'lbl-work' };
	const move = { type: 'moveToFolder', value: 'receipts' };
	/** A rule whose only action is a tab. */
	const tabRule = (id: string, condition: unknown, tab = 'updates', over: Record<string, unknown> = {}) =>
		rule(id, { conditions: [condition], actions: [toTab(tab)], ...over });
	const pins = () => listPins(ACCT).map((p) => [p.sender, p.category]);
	const step = () => rerunStep('data/rule_tabs_to_pins');

	it('become a sender pin, and are deleted, when all they did was put one sender in a tab', () => {
		store(ME, [
			rule('keep'),
			tabRule('address', from('News@Shop.example')),
			tabRule('domain', from('@github.com'), 'newsletters'),
			tabRule('ends', from('@bank.example', { op: 'ends_with' }), 'important'),
			tabRule('exactly', from('billing@shop.example', { op: 'is' }), 'promotions')
		]);

		step();

		// Only the rule that wasn't a tab rule is left, untouched.
		expect(getRules(ME)).toEqual([rule('keep')]);
		expect(pins()).toEqual([
			['@bank.example', 'important'],
			['@github.com', 'newsletters'],
			['billing@shop.example', 'promotions'],
			['news@shop.example', 'updates']
		]);
	});

	it('leave a pin you already have for that sender as it is, and are still deleted', () => {
		setPin(ACCT, 'news@shop.example', 'promotions', 5);
		store(ME, [tabRule('address', from('news@shop.example'), 'updates')]);

		step();

		expect(getRules(ME)).toEqual([]);
		expect(listPins(ACCT)).toEqual([{ sender: 'news@shop.example', category: 'promotions', createdAt: 5 }]);
	});

	it('pin an address beside its domain’s pin, as the rule won over the domain before', () => {
		setPin(ACCT, '@shop.example', 'promotions');
		store(ME, [tabRule('address', from('news@shop.example'), 'updates')]);
		step();
		expect(pins()).toEqual([
			['@shop.example', 'promotions'],
			['news@shop.example', 'updates']
		]);
	});

	it('let the later of two rules for one sender decide, as it did when both ran', () => {
		store(ME, [tabRule('first', from('news@shop.example'), 'updates'), tabRule('second', from('news@shop.example'), 'promotions')]);
		step();
		expect(getRules(ME)).toEqual([]);
		expect(pins()).toEqual([['news@shop.example', 'promotions']]);
	});

	it('only lose the tab when they also move the mail out of the Inbox', () => {
		store(ME, [
			rule('moves', { actions: [toTab('updates'), move, { type: 'markRead' }] }),
			rule('trashes', { actions: [{ type: 'delete' }, toTab('updates')] })
		]);

		step();

		// No flag: the move takes the mail out of the Inbox, where tabs mean nothing.
		expect(getRules(ME)).toEqual([
			rule('moves', { actions: [move, { type: 'markRead' }] }),
			rule('trashes', { actions: [{ type: 'delete' }] })
		]);
		expect(pins()).toEqual([]);
	});

	it('keep running without the tab, with a note, when they also label the mail', () => {
		const labelled = rule('labelled', { actions: [label, toTab('newsletters')] });
		store(ME, [labelled]);

		step();

		const [after] = getRules(ME);
		expect(after).toMatchObject({ enabled: true, attention: 'tab_removed', actions: [label], conditions: [fromShop] });
		// The tab it used to set is kept, in the rule as it was.
		expect(after.legacy).toEqual({ enabled: true, logic: 'allof', conditions: [fromShop], actions: [label, toTab('newsletters')] });
		// Still an ordinary running rule, and not a pin: a pin wouldn't add the label.
		expect(evaluateRulesForEmail(shopNewsletter, [after], { ...ctx, validMailboxIds: undefined }, '').firedRuleIds).toEqual(['labelled']);
		expect(pins()).toEqual([]);
	});

	it('get the same note when what is left only marks the mail', () => {
		store(ME, [rule('reads', { actions: [toTab('updates'), { type: 'markRead' }] })]);
		step();
		expect(getRules(ME)[0]).toMatchObject({ enabled: true, attention: 'tab_removed', actions: [{ type: 'markRead' }] });
	});

	it('are switched off and flagged when a pin can’t stand in for them', () => {
		const subject = { id: 's1', field: 'subject', op: 'contains', value: 'digest', negate: false };
		const cases: [string, Record<string, unknown>][] = [
			['two conditions', { conditions: [from('news@shop.example'), subject] }],
			['not the sender', { conditions: [subject] }],
			['a bare word', { conditions: [from('shop')] }],
			['a domain without its @', { conditions: [from('shop.example')] }],
			['negated', { conditions: [from('news@shop.example', { negate: true })] }],
			['does not contain', { conditions: [from('news@shop.example', { op: 'not_contains' })] }],
			['starts with', { conditions: [from('news@shop.example', { op: 'starts_with' })] }],
			// "From is exactly @domain" never matched any mail: not a pin either.
			['is a domain', { conditions: [from('@shop.example', { op: 'is' })] }],
			['a name and address', { conditions: [from('Shop <news@shop.example>')] }]
		];
		store(ME, cases.map(([id, over]) => rule(id, { actions: [toTab('updates')], ...over })));

		step();

		const after = getRules(ME);
		expect(after.map((r) => r.id)).toEqual(cases.map(([id]) => id));
		for (const r of after) {
			expect(r).toMatchObject({ enabled: false, attention: 'tab_rule', actions: [] });
			expect(r.legacy).toMatchObject({ enabled: true, actions: [toTab('updates')] });
		}
		// The original conditions are still there to read, and nothing was pinned.
		expect(after[0].legacy?.conditions).toEqual([from('news@shop.example'), subject]);
		expect(pins()).toEqual([]);
	});

	it('are flagged, not pinned, when they were switched off: a pin would start what the rule wasn’t doing', () => {
		store(ME, [tabRule('off', from('news@shop.example'), 'updates', { enabled: false })]);
		step();
		expect(getRules(ME)[0]).toMatchObject({ enabled: false, attention: 'tab_rule' });
		expect(getRules(ME)[0].legacy).toMatchObject({ enabled: false });
		expect(pins()).toEqual([]);
	});

	it('are flagged, not lost, when their account can’t be found', () => {
		const orphan = tabRule('orphan', from('news@shop.example'));
		store('gone@example.test', [orphan, rule('moves', { actions: [toTab('updates'), move] })]);

		step();

		const after = getRules('gone@example.test');
		expect(after[0]).toMatchObject({ id: 'orphan', enabled: false, attention: 'tab_rule', actions: [] });
		expect(after[0].legacy).toMatchObject({ conditions: orphan.conditions, actions: orphan.actions });
		// What needs no pin is converted all the same.
		expect(after[1]).toEqual(rule('moves', { actions: [move] }));
		expect(getDb().prepare('SELECT COUNT(*) AS n FROM jev_sender_pins').get()).toEqual({ n: 0 });
	});

	it('find the account whatever the case of its address', () => {
		store('ME@Example.Test', [tabRule('address', from('news@shop.example'))]);
		step();
		expect(getRules('ME@Example.Test')).toEqual([]);
		expect(getPinCategory(ACCT, 'news@shop.example')).toBe('updates');
	});

	it('only lose a tab action with no tab picked, which never did anything', () => {
		store(ME, [rule('half', { actions: [{ type: 'setCategory', value: '' }, label] }), rule('empty', { actions: [{ type: 'setCategory' }] })]);
		step();
		expect(getRules(ME)).toEqual([rule('half', { actions: [label] }), rule('empty', { actions: [] })]);
		expect(pins()).toEqual([]);
	});

	it('are never pinned when they had a Jev condition: the sender alone is more than the rule matched', () => {
		// "From the shop AND Jev says it's a receipt -> Updates".
		const mixed = rule('mixed', { conditions: [from('news@shop.example'), jevInvoice], actions: [toTab('updates')] });
		store(ME, [mixed]);

		// As on a database upgraded straight past both steps, and one step at a time.
		rerunStep('data/rules_exact_only');
		step();

		const [after] = getRules(ME);
		expect(after).toMatchObject({ enabled: false, attention: 'jev_condition', actions: [], conditions: [from('news@shop.example')] });
		// The first original, tab and Jev statement included.
		expect(after.legacy).toEqual({ enabled: true, logic: 'allof', conditions: mixed.conditions, actions: mixed.actions });
		expect(pins()).toEqual([]);

		// The tab step alone, on a rule the first step never saw.
		store(ME, [mixed]);
		step();
		expect(getRules(ME)[0]).toMatchObject({ enabled: false, attention: 'jev_condition', actions: [] });
		expect(pins()).toEqual([]);
	});

	it('change nothing when the step runs again', () => {
		setPin(ACCT, 'old@pin.example', 'promotions', 5);
		store(ME, [
			rule('keep'),
			tabRule('address', from('news@shop.example')),
			tabRule('word', from('shop')),
			rule('labelled', { actions: [label, toTab('newsletters')] }),
			rule('moves', { actions: [toTab('updates'), move] })
		]);
		store('gone@example.test', [tabRule('orphan', from('news@shop.example'))]);
		step();
		const once = [stored(ME), stored('gone@example.test'), JSON.stringify(listPins(ACCT))];

		retireStoredTabActions();
		step();
		runMigrations();
		expect([stored(ME), stored('gone@example.test'), JSON.stringify(listPins(ACCT))]).toEqual(once);
		expect(getRules(ME).map((r) => [r.id, r.attention ?? null])).toEqual([
			['keep', null],
			['word', 'tab_rule'],
			['labelled', 'tab_removed'],
			['moves', null]
		]);
	});

	it('runs once: a later start of the app doesn’t redo it', () => {
		runMigrations();
		const late = [tabRule('late', from('news@shop.example'))];
		store(ME, late);
		runMigrations();
		expect(stored(ME)).toBe(JSON.stringify(late));
		expect(pins()).toEqual([]);
	});

	it('are converted on save too, when an old browser tab sends one', () => {
		const cookies = { get: () => undefined, delete: () => {} } as unknown as Cookies;
		saveRules(
			ME,
			[tabRule('address', from('news@shop.example')), tabRule('word', from('shop')), rule('keep')] as unknown as Rule[],
			cookies
		);
		expect(getRules(ME).map((r) => [r.id, r.attention ?? null])).toEqual([
			['word', 'tab_rule'],
			['keep', null]
		]);
		expect(pins()).toEqual([['news@shop.example', 'updates']]);
	});
});
