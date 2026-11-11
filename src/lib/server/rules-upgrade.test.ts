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
import { getRules } from './db/queries/rules';
import { evaluateRulesForEmail } from './rules-engine';
import { saveRules } from './rules-store';
import { retireStoredJevConditions, upgradeRules } from './rules-upgrade';

const ME = 'me@example.test';

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
});

beforeEach(() => {
	getDb().prepare('DELETE FROM user_rules').run();
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
		const [flagged] = upgradeRules([rule('mixed', { conditions: [fromShop, jevInvoice] })]);
		const { attention: _attention, legacy: _legacy, ...rest } = flagged;
		const rewritten = { ...rest, enabled: true, conditions: [{ ...fromShop, id: 's1', field: 'subject', value: 'invoice' }] } as Rule;
		saveRules(ME, [rewritten], cookies);

		expect(getRules(ME)).toEqual([rewritten]);
		const invoice = { ...shopNewsletter, subject: 'Your invoice' } as Email;
		expect(evaluateRulesForEmail(invoice, getRules(ME), ctx, '').firedRuleIds).toEqual(['mixed']);
	});

	it('keeps a flagged rule flagged, with its first original, however often it is saved', () => {
		const flagged = upgradeRules([rule('mixed', { conditions: [fromShop, jevInvoice] })]);
		saveRules(ME, flagged, cookies);
		saveRules(ME, getRules(ME), cookies);
		expect(getRules(ME)).toEqual(flagged);
	});
});
