import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Point the lazy SQLite singleton at a throwaway file before anything opens it.
process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'zajel-rules-upgrade-')), 'test.db');
vi.mock('$lib/server/log', () => ({ logEvent: vi.fn(), errorFields: (e: unknown) => ({ error: String(e) }) }));

import type { Email } from '$lib/jmap/types';
import type { ActionRule } from '$lib/types/rules';
import { getDb } from '../db/index';
import { MigrationError, runMigrations } from '../db/migrate';
import { enqueueEmails } from '../db/queries/jev-decisions';
import { getPinCategory, listPins, pinFor, setPin } from '../db/queries/jev-learning';
import { getRulesCursor, setRulesCursor } from '../db/queries/rules';
import { evaluateRulesForEmail } from './engine';
import { retireStoredJevConditions, retireStoredTabActions, toTableRules } from './upgrade';

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
/** The rules stored under an address, as the upgrade steps left them. */
const storedRules = (email: string): ActionRule[] => {
	const row = getDb().prepare('SELECT rules_json FROM user_rules WHERE user_email = ?').get(email) as { rules_json: string } | undefined;
	return row ? (JSON.parse(row.rules_json) as ActionRule[]) : [];
};

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
	getDb().prepare('DELETE FROM rules').run();
	getDb().prepare('DELETE FROM jev_sender_pins').run();
	getDb().prepare('DELETE FROM jev_decisions').run();
	getDb().prepare('DELETE FROM rules_cursor').run();
});

describe('rules with a condition Jev judged', () => {
	it('are switched off and flagged, with the original kept to read', () => {
		const mixed = rule('mixed', { conditions: [fromShop, jevInvoice] });
		store(ME, [mixed]);

		rerunStep('data/rules_exact_only');

		const [after] = storedRules(ME);
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

		const [after] = storedRules(ME);
		expect(evaluateRulesForEmail(shopNewsletter, toTableRules([after]), ctx, '').firedRuleIds).toEqual([]);
		expect(evaluateRulesForEmail(shopNewsletter, toTableRules([{ ...after, enabled: true }]), ctx, '').firedRuleIds).toEqual([]);
	});

	it('are flagged whether the Jev condition stood alone, was one of any, or the rule was already off', () => {
		store(ME, [
			rule('alone', { conditions: [jevInvoice] }),
			rule('any', { logic: 'anyof', conditions: [fromShop, jevInvoice] }),
			rule('off', { enabled: false, conditions: [jevInvoice] })
		]);
		rerunStep('data/rules_exact_only');

		const after = storedRules(ME);
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

		const after = storedRules(ME);
		expect(after.map((r) => r.id)).toEqual(['first', 'jev', 'last']);
		expect(after[0]).toEqual(before[0]);
		expect(after[2]).toEqual(before[2]);
	});

	it('only lose a Jev condition that had no statement: the engine always ignored those', () => {
		const blank = { ...jevInvoice, value: '  ' };
		store(ME, [rule('half', { conditions: [fromShop, blank] })]);
		rerunStep('data/rules_exact_only');

		// Still on, not flagged, and matching what it matched before.
		expect(storedRules(ME)).toEqual([rule('half')]);
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

describe('mail the Jev worker still had queued when rules became the scheduler’s alone', () => {
	const NOW = Date.parse('2026-11-10T12:00:00Z');
	const HOUR = 60 * 60_000;
	const iso = (ms: number) => new Date(ms).toISOString();
	const jevRule = rule('mixed', { conditions: [fromShop, jevInvoice] });

	it('is put back in front of the scheduler: its cursor goes back to just before the oldest queued email', () => {
		store(ME, [rule('exact'), jevRule]);
		setRulesCursor(ME, iso(NOW - 1000));
		// Queued three hours and one hour ago, and never judged: no rules ran on them.
		enqueueEmails(ACCT, ['newer'], NOW - HOUR);
		enqueueEmails(ACCT, ['oldest'], NOW - 3 * HOUR);

		retireStoredJevConditions(NOW);

		// Five minutes before it was queued: a message is queued a little after it arrives.
		expect(getRulesCursor(ME)).toBe(iso(NOW - 3 * HOUR - 5 * 60_000));
	});

	it('never goes back more than a day', () => {
		store(ME, [jevRule]);
		setRulesCursor(ME, iso(NOW - 1000));
		enqueueEmails(ACCT, ['ancient'], NOW - 72 * HOUR);
		retireStoredJevConditions(NOW);
		expect(getRulesCursor(ME)).toBe(iso(NOW - 24 * HOUR));
	});

	it('leaves the cursor alone when nothing is queued, or only a sort of existing mail is', () => {
		store(ME, [jevRule]);
		setRulesCursor(ME, iso(NOW - 1000));
		// Existing mail queued for its tab: rules never ran on that, before or now.
		enqueueEmails(ACCT, ['backfill'], NOW - 3 * HOUR, true);
		retireStoredJevConditions(NOW);
		expect(getRulesCursor(ME)).toBe(iso(NOW - 1000));
	});

	it('leaves accounts alone whose rules the scheduler was already running', () => {
		// No Jev rule, or only one that was switched off: the worker never ran these rules.
		store(ME, [rule('exact'), rule('off', { enabled: false, conditions: [jevInvoice] })]);
		setRulesCursor(ME, iso(NOW - 1000));
		enqueueEmails(ACCT, ['queued'], NOW - 3 * HOUR);
		retireStoredJevConditions(NOW);
		expect(getRulesCursor(ME)).toBe(iso(NOW - 1000));
	});

	it('only ever moves the cursor back, and makes none where there was none', () => {
		store(ME, [jevRule]);
		enqueueEmails(ACCT, ['queued'], NOW - HOUR);
		// Already further back than the queue reaches.
		setRulesCursor(ME, iso(NOW - 5 * HOUR));
		retireStoredJevConditions(NOW);
		expect(getRulesCursor(ME)).toBe(iso(NOW - 5 * HOUR));

		getDb().prepare('DELETE FROM rules_cursor').run();
		store(ME, [jevRule]);
		retireStoredJevConditions(NOW);
		expect(getRulesCursor(ME)).toBeNull();
	});

	it('happens as part of the step the app runs at start', () => {
		store(ME, [jevRule]);
		setRulesCursor(ME, iso(Date.now() - 1000));
		const queuedAt = Date.now() - HOUR;
		enqueueEmails(ACCT, ['queued'], queuedAt);
		rerunStep('data/rules_exact_only');
		expect(getRulesCursor(ME)).toBe(iso(queuedAt - 5 * 60_000));
		expect(storedRules(ME)[0]).toMatchObject({ attention: 'jev_condition' });
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
	/** What is left of a tab rule: its flag, whether it is on, and its note. */
	const left = (email = ME) => storedRules(email).map((r) => [r.id, r.enabled, r.attention ?? null, r.tabNote ?? null]);

	it('become a sender pin when all they did was put one sender in a tab, and stay as a note saying so', () => {
		const address = tabRule('address', from('News@Shop.example'));
		store(ME, [
			rule('keep'),
			address,
			tabRule('domain', from('@github.com'), 'newsletters'),
			tabRule('ends', from('@bank.example', { op: 'ends_with' }), 'important'),
			tabRule('exactly', from('billing@shop.example', { op: 'is' }), 'promotions')
		]);

		step();

		expect(pins()).toEqual([
			['@bank.example', 'important'],
			['@github.com', 'newsletters'],
			['billing@shop.example', 'promotions'],
			['news@shop.example', 'updates']
		]);
		// No conversion is silent: each rule is still in the list, switched off,
		// saying which pin it became and how the rule had matched that sender.
		expect(left()).toEqual([
			['keep', true, null, null],
			['address', false, 'tab_pinned', { tab: 'updates', pin: { sender: 'news@shop.example', category: 'updates' }, op: 'contains', said: 'News@Shop.example' }],
			['domain', false, 'tab_pinned', { tab: 'newsletters', pin: { sender: '@github.com', category: 'newsletters' }, op: 'contains', said: '@github.com' }],
			['ends', false, 'tab_pinned', { tab: 'important', pin: { sender: '@bank.example', category: 'important' }, op: 'ends_with', said: '@bank.example' }],
			['exactly', false, 'tab_pinned', { tab: 'promotions', pin: { sender: 'billing@shop.example', category: 'promotions' }, op: 'is', said: 'billing@shop.example' }]
		]);
		const [keep, stub] = storedRules(ME);
		expect(keep).toEqual(rule('keep'));
		// The stub has nothing left to do, and keeps the rule as it was.
		expect(stub).toMatchObject({ actions: [], conditions: address.conditions });
		expect(stub.legacy).toEqual({ enabled: true, logic: 'allof', conditions: address.conditions, actions: address.actions });
		// And never runs, switched on or not.
		expect(evaluateRulesForEmail(shopNewsletter, toTableRules([{ ...stub, enabled: true }]), ctx, '').firedRuleIds).toEqual([]);
	});

	it('say so in the note when the pin can match less than the rule did', () => {
		// "contains @amazon.co" also matched amazon.com and amazon.co.uk; the pin is amazon.co alone.
		store(ME, [tabRule('partial-domain', from('@amazon.co')), tabRule('partial-address', from('ob@example.com'), 'promotions')]);
		step();

		expect(left()).toEqual([
			['partial-domain', false, 'tab_pinned', { tab: 'updates', pin: { sender: '@amazon.co', category: 'updates' }, op: 'contains', said: '@amazon.co' }],
			['partial-address', false, 'tab_pinned', { tab: 'promotions', pin: { sender: 'ob@example.com', category: 'promotions' }, op: 'contains', said: 'ob@example.com' }]
		]);
		// Less, never more: mail the rule matched and the pin doesn't stays in Important.
		expect(pinFor(listPins(ACCT), 'deals@amazon.com')).toBeNull();
		expect(pinFor(listPins(ACCT), 'bob@example.com')).toBeNull();
		expect(pinFor(listPins(ACCT), 'ob@example.com')?.category).toBe('promotions');
	});

	it('note a pin you already had to the same tab, and leave it as it is', () => {
		setPin(ACCT, 'news@shop.example', 'updates', 5);
		store(ME, [tabRule('address', from('news@shop.example'), 'updates')]);

		step();

		expect(listPins(ACCT)).toEqual([{ sender: 'news@shop.example', category: 'updates', createdAt: 5 }]);
		expect(left()).toEqual([
			['address', false, 'tab_pinned', { tab: 'updates', pin: { sender: 'news@shop.example', category: 'updates' }, op: 'contains', said: 'news@shop.example', existing: true }]
		]);
	});

	it('are flagged, with your pin kept, when the sender is already pinned to another tab', () => {
		setPin(ACCT, 'news@shop.example', 'promotions', 5);
		store(ME, [tabRule('address', from('news@shop.example'), 'updates')]);

		step();

		// The rule used to win over the pin. It is not dropped without a word,
		// and the pin is not changed: the owner is told which was kept.
		expect(listPins(ACCT)).toEqual([{ sender: 'news@shop.example', category: 'promotions', createdAt: 5 }]);
		expect(left()).toEqual([
			[
				'address',
				false,
				'tab_rule',
				{
					tab: 'updates',
					pin: { sender: 'news@shop.example', category: 'updates' },
					op: 'contains',
					said: 'news@shop.example',
					why: 'pinned_elsewhere',
					kept: { sender: 'news@shop.example', category: 'promotions' }
				}
			]
		]);
		expect(storedRules(ME)[0].legacy).toMatchObject({ enabled: true, actions: [toTab('updates')] });
	});

	it('are flagged when they are for a whole domain and one of its addresses is pinned to another tab', () => {
		// That address's pin would now win over the domain's, where the rule used to win.
		setPin(ACCT, 'news@shop.example', 'newsletters');
		store(ME, [tabRule('domain', from('@shop.example'), 'promotions')]);
		step();
		expect(pins()).toEqual([['news@shop.example', 'newsletters']]);
		expect(left()[0].slice(0, 3)).toEqual(['domain', false, 'tab_rule']);
		expect(storedRules(ME)[0].tabNote).toMatchObject({ why: 'pinned_elsewhere', kept: { sender: 'news@shop.example', category: 'newsletters' } });

		// The same when the address pin came from an earlier rule of the same run.
		getDb().prepare('DELETE FROM jev_sender_pins').run();
		store(ME, [tabRule('address', from('news@shop.example'), 'newsletters'), tabRule('domain', from('@shop.example'), 'promotions')]);
		step();
		expect(pins()).toEqual([['news@shop.example', 'newsletters']]);
		expect(left().map((r) => r.slice(0, 3))).toEqual([
			['address', false, 'tab_pinned'],
			['domain', false, 'tab_rule']
		]);
	});

	it('pin an address beside its domain’s pin, as the rule won over the domain before', () => {
		setPin(ACCT, '@shop.example', 'promotions');
		store(ME, [tabRule('address', from('news@shop.example'), 'updates')]);
		step();
		expect(pins()).toEqual([
			['@shop.example', 'promotions'],
			['news@shop.example', 'updates']
		]);
		expect(left()[0].slice(0, 3)).toEqual(['address', false, 'tab_pinned']);
	});

	it('pin the later of two rules for one sender, as that tab is where its mail ended up, and note both', () => {
		store(ME, [tabRule('first', from('news@shop.example'), 'updates'), tabRule('second', from('news@shop.example'), 'promotions')]);
		step();
		expect(pins()).toEqual([['news@shop.example', 'promotions']]);
		expect(left().map((r) => r.slice(0, 3))).toEqual([
			['first', false, 'tab_rule'],
			['second', false, 'tab_pinned']
		]);
		// The first says which tab won, and offers its own with one click.
		expect(storedRules(ME)[0].tabNote).toMatchObject({
			tab: 'updates',
			pin: { sender: 'news@shop.example', category: 'updates' },
			why: 'pinned_elsewhere',
			kept: { sender: 'news@shop.example', category: 'promotions' }
		});

		// Back and forth: every note says where the sender's mail goes now.
		getDb().prepare('DELETE FROM jev_sender_pins').run();
		store(ME, [
			tabRule('a', from('news@shop.example'), 'updates'),
			tabRule('b', from('news@shop.example'), 'promotions'),
			tabRule('c', from('news@shop.example'), 'updates')
		]);
		step();
		expect(pins()).toEqual([['news@shop.example', 'updates']]);
		expect(left().map((r) => r.slice(0, 3))).toEqual([
			['a', false, 'tab_pinned'],
			['b', false, 'tab_rule'],
			['c', false, 'tab_pinned']
		]);
		expect(storedRules(ME)[1].tabNote).toMatchObject({ why: 'pinned_elsewhere', kept: { category: 'updates' } });
		expect(storedRules(ME)[0].tabNote).not.toHaveProperty('kept');
	});

	it('never change a pin that was there before, whatever the rules of the run say', () => {
		setPin(ACCT, 'news@shop.example', 'newsletters', 5);
		store(ME, [tabRule('first', from('news@shop.example'), 'newsletters'), tabRule('second', from('news@shop.example'), 'promotions')]);
		step();
		expect(listPins(ACCT)).toEqual([{ sender: 'news@shop.example', category: 'newsletters', createdAt: 5 }]);
		expect(left().map((r) => r.slice(0, 3))).toEqual([
			['first', false, 'tab_pinned'],
			['second', false, 'tab_rule']
		]);
	});

	it('say an earlier rule stopped processing before saying no account was found', () => {
		const stopper = rule('stopper', { actions: [label, { type: 'stopProcessing' }] });
		store('gone@example.test', [stopper, tabRule('after', from('news@shop.example'))]);
		step();
		expect(storedRules('gone@example.test')[1].tabNote?.why).toBe('after_stop');
	});

	it('are flagged, not pinned, behind a rule that stops processing: the rule never saw all of the sender’s mail', () => {
		const stopper = rule('stopper', { actions: [label, { type: 'stopProcessing' }] });
		store(ME, [tabRule('before', from('early@x.example')), stopper, tabRule('after', from('news@shop.example'), 'promotions')]);

		step();

		expect(pins()).toEqual([['early@x.example', 'updates']]);
		expect(left().map((r) => r.slice(0, 3))).toEqual([
			['before', false, 'tab_pinned'],
			['stopper', true, null],
			['after', false, 'tab_rule']
		]);
		// With the pin one click would make of it.
		expect(storedRules(ME)[2].tabNote).toEqual({
			tab: 'promotions',
			pin: { sender: 'news@shop.example', category: 'promotions' },
			op: 'contains',
			said: 'news@shop.example',
			why: 'after_stop'
		});

		// A stop rule that was switched off stopped nothing.
		getDb().prepare('DELETE FROM jev_sender_pins').run();
		store(ME, [{ ...stopper, enabled: false }, tabRule('after', from('news@shop.example'), 'promotions')]);
		step();
		expect(left()[1].slice(0, 3)).toEqual(['after', false, 'tab_pinned']);
	});

	it('only lose the tab when they also move the mail out of the Inbox', () => {
		store(ME, [
			rule('moves', { actions: [toTab('updates'), move, { type: 'markRead' }] }),
			rule('trashes', { actions: [{ type: 'delete' }, toTab('updates')] })
		]);

		step();

		// No flag: the move takes the mail out of the Inbox, where tabs mean nothing.
		expect(storedRules(ME)).toEqual([
			rule('moves', { actions: [move, { type: 'markRead' }] }),
			rule('trashes', { actions: [{ type: 'delete' }] })
		]);
		expect(pins()).toEqual([]);
	});

	it('keep running without the tab, with a note, when they also label the mail', () => {
		const labelled = rule('labelled', { actions: [label, toTab('newsletters')] });
		store(ME, [labelled]);

		step();

		const [after] = storedRules(ME);
		expect(after).toMatchObject({ enabled: true, attention: 'tab_removed', actions: [label], conditions: [fromShop] });
		// The tab it used to set is kept, in the rule as it was.
		expect(after.legacy).toEqual({ enabled: true, logic: 'allof', conditions: [fromShop], actions: [label, toTab('newsletters')] });
		// Still an ordinary running rule, and not a pin: a pin wouldn't add the label.
		expect(evaluateRulesForEmail(shopNewsletter, toTableRules([after]), { ...ctx, validMailboxIds: undefined }, '').firedRuleIds).toEqual(['labelled']);
		expect(pins()).toEqual([]);
	});

	it('get the same note when what is left only marks the mail, or moves it nowhere', () => {
		store(ME, [
			rule('reads', { actions: [toTab('updates'), { type: 'markRead' }] }),
			rule('no-target', { actions: [toTab('updates'), { type: 'moveToFolder', value: '' }] })
		]);
		step();
		expect(storedRules(ME)[0]).toMatchObject({ enabled: true, attention: 'tab_removed', actions: [{ type: 'markRead' }] });
		expect(storedRules(ME)[1]).toMatchObject({ enabled: true, attention: 'tab_removed' });
	});

	it('are switched off and flagged when a pin can’t stand in for them', () => {
		const subject = { id: 's1', field: 'subject', op: 'contains', value: 'digest', negate: false };
		const address = { sender: 'news@shop.example', category: 'updates' };
		// [name, the rule, whether a one-click pin is offered for it]
		const cases: [string, Record<string, unknown>, unknown][] = [
			['two conditions', { conditions: [from('news@shop.example'), subject] }, undefined],
			['not the sender', { conditions: [subject] }, undefined],
			['a bare word', { conditions: [from('shop')] }, undefined],
			['a domain without its @', { conditions: [from('shop.example')] }, undefined],
			['a name and address', { conditions: [from('Shop <news@shop.example>')] }, undefined],
			// The opposite of a sender is not a sender: no pin, and none offered.
			['negated', { conditions: [from('news@shop.example', { negate: true })] }, undefined],
			// The engine reads NOT by truthiness, so this is a NOT as well.
			['negated with 1', { conditions: [from('news@shop.example', { negate: 1 })] }, undefined],
			['negated with a string', { conditions: [from('news@shop.example', { negate: 'true' })] }, undefined],
			['does not contain', { conditions: [from('news@shop.example', { op: 'not_contains' })] }, undefined],
			// These name a sender, but matched the display name, or nothing at all: not
			// pinned for the owner, who can still choose to with one click.
			['starts with', { conditions: [from('news@shop.example', { op: 'starts_with' })] }, address],
			['is a domain', { conditions: [from('@shop.example', { op: 'is' })] }, { sender: '@shop.example', category: 'updates' }]
		];
		store(ME, cases.map(([id, over]) => rule(id, { actions: [toTab('updates')], ...over })));

		step();

		const after = storedRules(ME);
		expect(after.map((r) => r.id)).toEqual(cases.map(([id]) => id));
		after.forEach((r, i) => {
			expect(r, r.id).toMatchObject({ enabled: false, attention: 'tab_rule', actions: [] });
			expect(r.legacy, r.id).toMatchObject({ enabled: true, actions: [toTab('updates')] });
			expect(r.tabNote?.why, r.id).toBe('not_one_sender');
			expect(r.tabNote?.tab, r.id).toBe('updates');
			expect(r.tabNote?.pin, r.id).toEqual(cases[i][2]);
		});
		// The original conditions are still there to read, and nothing was pinned.
		expect(after[0].legacy?.conditions).toEqual([from('news@shop.example'), subject]);
		expect(pins()).toEqual([]);
	});

	it('are flagged, not pinned, when they were switched off: a pin would start what the rule wasn’t doing', () => {
		store(ME, [tabRule('off', from('news@shop.example'), 'updates', { enabled: false })]);
		step();
		expect(storedRules(ME)[0]).toMatchObject({ enabled: false, attention: 'tab_rule' });
		expect(storedRules(ME)[0].legacy).toMatchObject({ enabled: false });
		expect(storedRules(ME)[0].tabNote).toMatchObject({ why: 'switched_off', pin: { sender: 'news@shop.example', category: 'updates' } });
		expect(pins()).toEqual([]);
	});

	it('are flagged, not lost, when their account can’t be found', () => {
		const orphan = tabRule('orphan', from('news@shop.example'));
		store('gone@example.test', [orphan, rule('moves', { actions: [toTab('updates'), move] })]);

		step();

		const after = storedRules('gone@example.test');
		expect(after[0]).toMatchObject({ id: 'orphan', enabled: false, attention: 'tab_rule', actions: [] });
		expect(after[0].tabNote?.why).toBe('no_account');
		expect(after[0].legacy).toMatchObject({ conditions: orphan.conditions, actions: orphan.actions });
		// What needs no pin is converted all the same.
		expect(after[1]).toEqual(rule('moves', { actions: [move] }));
		expect(getDb().prepare('SELECT COUNT(*) AS n FROM jev_sender_pins').get()).toEqual({ n: 0 });
	});

	it('find the account whatever the case of its address', () => {
		store('ME@Example.Test', [tabRule('address', from('news@shop.example'))]);
		step();
		expect(left('ME@Example.Test')[0].slice(0, 3)).toEqual(['address', false, 'tab_pinned']);
		expect(getPinCategory(ACCT, 'news@shop.example')).toBe('updates');
	});

	it('only lose a tab action with no tab picked, which never did anything', () => {
		store(ME, [
			rule('half', { actions: [{ type: 'setCategory', value: '' }, label] }),
			rule('empty', { actions: [{ type: 'setCategory' }] }),
			rule('not-a-tab', { actions: [toTab('bogus')] })
		]);
		step();
		expect(storedRules(ME)).toEqual([rule('half', { actions: [label] }), rule('empty', { actions: [] }), rule('not-a-tab', { actions: [] })]);
		expect(pins()).toEqual([]);
	});

	it('use the last tab a rule set, as the engine did', () => {
		store(ME, [rule('multi', { conditions: [from('b@x.example')], actions: [toTab('updates'), toTab('promotions'), toTab('bogus')] })]);
		step();
		expect(pins()).toEqual([['b@x.example', 'promotions']]);
	});

	it('are never pinned when they had a Jev condition: the sender alone is more than the rule matched', () => {
		// "From the shop AND Jev says it's a receipt -> Updates".
		const mixed = rule('mixed', { conditions: [from('news@shop.example'), jevInvoice], actions: [toTab('updates')] });
		store(ME, [mixed]);

		// As on a database upgraded straight past both steps, and one step at a time.
		rerunStep('data/rules_exact_only');
		step();

		const [after] = storedRules(ME);
		expect(after).toMatchObject({ enabled: false, attention: 'jev_condition', actions: [], conditions: [from('news@shop.example')] });
		// The first original, tab and Jev statement included.
		expect(after.legacy).toEqual({ enabled: true, logic: 'allof', conditions: mixed.conditions, actions: mixed.actions });
		expect(pins()).toEqual([]);

		// The tab step alone, on a rule the first step never saw.
		store(ME, [mixed]);
		step();
		expect(storedRules(ME)[0]).toMatchObject({ enabled: false, attention: 'jev_condition', actions: [] });
		expect(pins()).toEqual([]);
	});

	it('change nothing when the step runs again', () => {
		setPin(ACCT, 'old@pin.example', 'promotions', 5);
		store(ME, [
			rule('keep'),
			tabRule('address', from('news@shop.example')),
			tabRule('word', from('shop')),
			rule('labelled', { actions: [label, toTab('newsletters')] }),
			rule('moves', { actions: [toTab('updates'), move] }),
			tabRule('conflict', from('old@pin.example'), 'updates')
		]);
		store('gone@example.test', [tabRule('orphan', from('news@shop.example'))]);
		step();
		const once = [stored(ME), stored('gone@example.test'), JSON.stringify(listPins(ACCT))];

		retireStoredTabActions();
		step();
		runMigrations();
		expect([stored(ME), stored('gone@example.test'), JSON.stringify(listPins(ACCT))]).toEqual(once);
		expect(storedRules(ME).map((r) => [r.id, r.attention ?? null])).toEqual([
			['keep', null],
			['address', 'tab_pinned'],
			['word', 'tab_rule'],
			['labelled', 'tab_removed'],
			['moves', null],
			['conflict', 'tab_rule']
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

	it('is undone whole when it fails halfway: no pins, no changed rules, and it runs again next start', () => {
		const before = [tabRule('address', from('news@shop.example'))];
		store(ME, before);
		store('zzz@example.test', [tabRule('word', from('shop'))]);
		getDb().exec(
			`CREATE TRIGGER fail_zzz BEFORE UPDATE ON user_rules WHEN NEW.user_email = 'zzz@example.test'
			 BEGIN SELECT RAISE(ABORT, 'disk full'); END`
		);
		vi.spyOn(console, 'error').mockImplementation(() => {});
		let thrown: unknown;
		try {
			step();
		} catch (err) {
			thrown = err;
		} finally {
			getDb().exec('DROP TRIGGER fail_zzz');
		}

		expect(thrown).toBeInstanceOf(MigrationError);
		// The pin made for the first account went with the rest.
		expect(pins()).toEqual([]);
		expect(stored(ME)).toBe(JSON.stringify(before));
		expect(getDb().prepare(`SELECT 1 FROM _migrations WHERE name = 'data/rule_tabs_to_pins'`).get()).toBeUndefined();

		runMigrations();
		expect(pins()).toEqual([['news@shop.example', 'updates']]);
		expect(left()[0].slice(0, 3)).toEqual(['address', false, 'tab_pinned']);
	});
});
