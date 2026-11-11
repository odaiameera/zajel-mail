import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'zajel-rules-to-table-')), 'test.db');
vi.mock('$lib/server/log', () => ({ logEvent: vi.fn(), errorFields: (e: unknown) => ({ error: String(e) }) }));

import { getDb } from '../db/index';
import { MigrationError, runMigrations } from '../db/migrate';
import { listRules } from './store';

const ME = 'me@example.test';
const ACCT = 'acct-me';
const OTHER = 'acct-other';
const STEP = 'data/rules_to_table';

/** Rules as an earlier version stored them, written straight to the old table. */
function store(email: string, rules: unknown): void {
	getDb()
		.prepare(
			`INSERT INTO user_rules (user_email, rules_json) VALUES (?, ?)
			 ON CONFLICT (user_email) DO UPDATE SET rules_json = excluded.rules_json`
		)
		.run(email, JSON.stringify(rules));
}
const oldTable = () => getDb().prepare('SELECT user_email, rules_json, updated_at FROM user_rules ORDER BY user_email').all();
const marked = (name = STEP) => !!getDb().prepare('SELECT 1 FROM _migrations WHERE name = ?').get(name);

/** Run the step as a fresh start of the app would: by forgetting it ran, and migrating. */
function rerun(...steps: string[]): void {
	for (const name of steps.length ? steps : [STEP]) getDb().prepare('DELETE FROM _migrations WHERE name = ?').run(name);
	runMigrations();
}

const fromShop = { id: 'f1', field: 'from', op: 'contains', value: 'shop.example', negate: false };
const rule = (id: string, actions: unknown[], over: Record<string, unknown> = {}) => ({
	id,
	name: id,
	enabled: true,
	logic: 'allof',
	conditions: [fromShop],
	actions,
	createdAt: 7,
	...over
});
const label = (id: string) => ({ type: 'applyLabel', value: id });
const move = (id: string) => ({ type: 'moveToFolder', value: id });

/** What a row says, without the bookkeeping. */
const said = (accountId = ACCT) =>
	listRules(accountId).map(({ createdAt: _c, updatedAt: _u, ...r }) => r);

beforeAll(() => {
	runMigrations();
	getDb().exec(`
		INSERT INTO app_user (id, email, password_hash) VALUES ('u1', 'u1@example.test', 'x');
		INSERT INTO mail_accounts (id, user_id, email, server_url, jmap_account_id, secret_enc) VALUES
			('${ACCT}', 'u1', '${ME}', 'https://mail.example', 'j1', 'x'),
			('${OTHER}', 'u1', 'other@example.test', 'https://mail.example', 'j2', 'x');
	`);
});

beforeEach(() => {
	getDb().prepare('DELETE FROM user_rules').run();
	getDb().prepare('DELETE FROM rules').run();
	getDb().exec('DROP TRIGGER IF EXISTS boom');
});

describe('moving stored rules into the rules table', () => {
	it('copies single-action rules as they were, in their order, keeping their ids', () => {
		store(ME, [
			rule('label', [label('WORK')]),
			rule('move', [move('RCPT')], { enabled: false, logic: 'anyof' }),
			rule('delete', [{ type: 'delete' }]),
			rule('important', [{ type: 'markImportant' }]),
			rule('read', [{ type: 'markRead' }]),
			rule('stop', [label('WORK'), { type: 'stopProcessing' }])
		]);
		rerun();
		const base = { conditions: [fromShop], markRead: false, star: false, stop: false, enabled: true, logic: 'allof' };
		expect(said()).toEqual([
			{ ...base, id: 'label', name: 'label', position: 0, target: { kind: 'label', mailboxId: 'WORK' } },
			{ ...base, id: 'move', name: 'move', position: 1, target: { kind: 'folder', mailboxId: 'RCPT' }, enabled: false, logic: 'anyof' },
			// "Delete" is Trash, and "mark important" is star.
			{ ...base, id: 'delete', name: 'delete', position: 2, target: { kind: 'trash' } },
			{ ...base, id: 'important', name: 'important', position: 3, target: { kind: 'none' }, star: true },
			{ ...base, id: 'read', name: 'read', position: 4, target: { kind: 'none' }, markRead: true },
			{ ...base, id: 'stop', name: 'stop', position: 5, target: { kind: 'label', mailboxId: 'WORK' }, stop: true }
		]);
		expect(listRules(ACCT)[0].createdAt).toBe(7);
	});

	it('makes a rule that filed into several places one rule per place, side by side', () => {
		store(ME, [
			rule('before', [label('X')]),
			rule('multi', [
				{ type: 'markRead' },
				label('L1'),
				{ type: 'markImportant' },
				label('L2'),
				move('F'),
				{ type: 'stopProcessing' }
			]),
			rule('after', [label('Y')])
		]);
		rerun();
		const rows = said();
		expect(rows.map((r) => [r.id, r.name, r.position, r.target, r.markRead, r.star, r.stop])).toEqual([
			['before', 'before', 0, { kind: 'label', mailboxId: 'X' }, false, false, false],
			['multi', 'multi', 1, { kind: 'label', mailboxId: 'L1' }, true, true, false],
			['multi~2', 'multi', 2, { kind: 'label', mailboxId: 'L2' }, false, false, false],
			['multi~3', 'multi', 3, { kind: 'folder', mailboxId: 'F' }, false, false, true],
			['after', 'after', 4, { kind: 'label', mailboxId: 'Y' }, false, false, false]
		]);
		expect(rows.every((r) => JSON.stringify(r.conditions) === JSON.stringify([fromShop]))).toBe(true);
		// The first says nothing; the two after it say why they are there.
		expect(rows.map((r) => [r.attention ?? null, r.note ?? null])).toEqual([
			[null, null],
			[null, null],
			['split', { splitInto: 3 }],
			['split', { splitInto: 3 }],
			[null, null]
		]);
	});

	it('carries each flagged kind over intact, on every rule a flagged one becomes', () => {
		const legacy = { enabled: true, logic: 'allof', conditions: [fromShop, { field: 'jev', value: 'an invoice' }], actions: [] };
		const tabNote = { tab: 'updates', pin: { sender: 'news@shop.example', category: 'updates' }, op: 'contains', said: 'news@shop.example', why: 'switched_off' };
		store(ME, [
			rule('jev', [label('A'), label('B')], { enabled: false, attention: 'jev_condition', legacy }),
			rule('tabRule', [], { enabled: false, attention: 'tab_rule', legacy, tabNote }),
			rule('tabPinned', [], { enabled: false, attention: 'tab_pinned', legacy, tabNote: { tab: 'updates', pin: tabNote.pin } }),
			rule('tabRemoved', [label('A')], { attention: 'tab_removed', legacy })
		]);
		rerun();
		expect(said().map((r) => [r.id, r.enabled, r.attention, r.note ?? null, r.legacy])).toEqual([
			['jev', false, 'jev_condition', null, legacy],
			// The second half of a rule waiting to be rewritten must not run either.
			['jev~2', false, 'jev_condition', { splitInto: 2 }, legacy],
			['tabRule', false, 'tab_rule', { tab: tabNote }, legacy],
			['tabPinned', false, 'tab_pinned', { tab: { tab: 'updates', pin: tabNote.pin } }, legacy],
			['tabRemoved', true, 'tab_removed', null, legacy]
		]);
	});

	it('keeps a rule whose folder or label has gone, as it was', () => {
		store(ME, [rule('gone', [move('DELETED-FOLDER')])]);
		rerun();
		expect(listRules(ACCT)[0].target).toEqual({ kind: 'folder', mailboxId: 'DELETED-FOLDER' });
	});

	it('leaves the rules of an address with no account where they are, and never writes the old table', () => {
		store('nobody@example.test', [rule('lost', [label('A')])]);
		store(ME, [rule('mine', [label('A')])]);
		const before = oldTable();
		rerun();
		expect(getDb().prepare('SELECT COUNT(*) AS n FROM rules').get()).toEqual({ n: 1 });
		expect(oldTable()).toEqual(before);
	});

	it('finds the account of an address stored in another case, the exact one first', () => {
		store('Other@Example.TEST', [rule('theirs', [label('A')])]);
		rerun();
		expect(said(OTHER).map((r) => r.id)).toEqual(['theirs']);

		getDb().prepare('DELETE FROM rules').run();
		store('ME@EXAMPLE.TEST', [rule('shouting', [label('A')])]);
		store(ME, [rule('exact', [label('A')])]);
		rerun();
		expect(said().map((r) => r.id)).toEqual(['exact']);
	});

	it('changes nothing run twice', () => {
		store(ME, [rule('one', [label('A'), label('B')])]);
		rerun();
		const first = listRules(ACCT);
		rerun();
		expect(listRules(ACCT)).toEqual(first);
	});

	it('runs after the two earlier rule steps, on what they leave', () => {
		store(ME, [rule('tabbed', [label('A'), { type: 'setCategory', value: 'updates' }])]);
		rerun('data/rules_exact_only', 'data/rule_tabs_to_pins', STEP);
		expect(said()).toMatchObject([{ id: 'tabbed', attention: 'tab_removed', target: { kind: 'label', mailboxId: 'A' } }]);
	});

	it('leaves no rows and no marker when it fails part way', () => {
		store(ME, [rule('fine', [label('A')])]);
		store('other@example.test', [rule('fine too', [label('A')]), rule('boom', [label('B')])]);
		getDb().exec(`CREATE TEMP TRIGGER boom BEFORE INSERT ON rules WHEN NEW.name = 'boom' BEGIN SELECT RAISE(ABORT, 'disk full'); END`);
		const before = oldTable();

		expect(() => rerun()).toThrow(MigrationError);
		expect(getDb().prepare('SELECT COUNT(*) AS n FROM rules').get()).toEqual({ n: 0 });
		expect(marked()).toBe(false);
		expect(oldTable()).toEqual(before);

		// Fixed, the next start does the whole move.
		getDb().exec('DROP TRIGGER boom');
		runMigrations();
		expect(said().map((r) => r.id)).toEqual(['fine']);
		expect(said(OTHER).map((r) => r.id)).toEqual(['fine too', 'boom']);
		expect(marked()).toBe(true);
	});
});
