import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'zajel-rules-store-')), 'test.db');
vi.mock('$lib/server/log', () => ({ logEvent: vi.fn(), errorFields: (e: unknown) => ({ error: String(e) }) }));

import { getDb } from '../db/index';
import { runMigrations } from '../db/migrate';
import type { Rule, RuleDraft } from '$lib/types/rules';
import {
	createRule,
	deleteRule,
	deleteRulesForMailbox,
	dismissNote,
	getRule,
	importRules,
	listRules,
	reorderRules,
	setRuleBasics,
	updateRule
} from './store';

const A = 'acct-a';
const B = 'acct-b';

const draft = (name: string, over: Partial<RuleDraft> = {}): RuleDraft => ({
	name,
	enabled: true,
	logic: 'allof',
	conditions: [{ id: 'c1', field: 'from', op: 'contains', value: 'shop.example', negate: false }],
	target: { kind: 'folder', mailboxId: 'RCPT' },
	markRead: false,
	star: false,
	stop: false,
	...over
});

/** A rule as an upgrade leaves it, flags and all. */
const flagged = (id: string, over: Partial<Rule> = {}): Rule => ({
	...draft(id, { enabled: false }),
	id,
	position: 0,
	createdAt: 1,
	updatedAt: 1,
	attention: 'jev_condition',
	legacy: { enabled: true, logic: 'allof', conditions: [], actions: [] },
	...over
});

beforeAll(() => {
	runMigrations();
	getDb().exec(`
		INSERT INTO app_user (id, email, password_hash) VALUES ('u1', 'u1@example.test', 'x');
		INSERT INTO mail_accounts (id, user_id, email, server_url, jmap_account_id, secret_enc) VALUES
			('${A}', 'u1', 'a@example.test', 'https://mail.example', 'j1', 'x'),
			('${B}', 'u1', 'b@example.test', 'https://mail.example', 'j2', 'x');
	`);
});

beforeEach(() => {
	getDb().prepare('DELETE FROM rules').run();
});

const names = (account = A) => listRules(account).map((r) => r.name);

describe('the rules store', () => {
	it('creates rules at the end of the list, and reads them back as saved', () => {
		const one = createRule(A, draft('one', { target: { kind: 'junk' }, markRead: true, star: true, stop: true }), 5);
		createRule(A, draft('two', { target: { kind: 'label', mailboxId: 'WORK' }, logic: 'anyof' }));
		createRule(A, draft('three', { target: { kind: 'none' }, markRead: true }));
		expect(names()).toEqual(['one', 'two', 'three']);
		expect(getRule(A, one.id)).toEqual({
			...draft('one', { target: { kind: 'junk' }, markRead: true, star: true, stop: true }),
			id: one.id,
			position: 0,
			createdAt: 5,
			updatedAt: 5
		});
		expect(listRules(A).map((r) => r.target)).toEqual([
			{ kind: 'junk' },
			{ kind: 'label', mailboxId: 'WORK' },
			{ kind: 'none' }
		]);
	});

	it('updates and deletes', () => {
		const r = createRule(A, draft('one'));
		expect(updateRule(A, r.id, draft('renamed', { enabled: false }))).toMatchObject({ name: 'renamed', enabled: false });
		expect(deleteRule(A, r.id)).toBe(true);
		expect(listRules(A)).toEqual([]);
	});

	it('finds no rule of another account', () => {
		const r = createRule(A, draft('mine'));
		expect(getRule(B, r.id)).toBeNull();
		expect(updateRule(B, r.id, draft('taken'))).toBeNull();
		expect(deleteRule(B, r.id)).toBe(false);
		expect(dismissNote(B, r.id)).toBeNull();
		expect(getRule(A, r.id)).toMatchObject({ name: 'mine' });
	});

	it('reorders, given exactly the account’s rule ids', () => {
		const [a, b, c] = ['a', 'b', 'c'].map((n) => createRule(A, draft(n)));
		const theirs = createRule(B, draft('theirs'));
		expect(reorderRules(A, [c.id, a.id, b.id])).toBe(true);
		expect(names()).toEqual(['c', 'a', 'b']);

		// A missing id, a foreign one, an id twice: each refused, and the order kept.
		expect(reorderRules(A, [c.id, a.id])).toBe(false);
		expect(reorderRules(A, [c.id, a.id, theirs.id])).toBe(false);
		expect(reorderRules(A, [c.id, a.id, b.id, theirs.id])).toBe(false);
		expect(reorderRules(A, [c.id, a.id, a.id])).toBe(false);
		expect(names()).toEqual(['c', 'a', 'b']);
		expect(names(B)).toEqual(['theirs']);
	});

	it('goes with the account', () => {
		createRule(A, draft('one'));
		createRule(B, draft('kept'));
		getDb().prepare('DELETE FROM mail_accounts WHERE id = ?').run(A);
		expect(listRules(A)).toEqual([]);
		expect(names(B)).toEqual(['kept']);
		getDb()
			.prepare(
				`INSERT INTO mail_accounts (id, user_id, email, server_url, jmap_account_id, secret_enc) VALUES (?, 'u1', 'a@example.test', 'https://mail.example', 'j1', 'x')`
			)
			.run(A);
	});

	it('keeps a flagged rule flagged and off until it is saved as a rewrite', () => {
		importRules(A, [flagged('jev')]);
		// Saved without rewrite, even asking to be on: edited, still flagged and off.
		const sneaky = { ...draft('jev'), attention: undefined, legacy: undefined } as RuleDraft;
		expect(updateRule(A, 'jev', sneaky)).toMatchObject({ enabled: false, attention: 'jev_condition', legacy: { enabled: true } });
		// "Save as exact rule": switched on, flag and old copy gone.
		const saved = updateRule(A, 'jev', draft('jev', { enabled: false }), { rewrite: true })!;
		expect(saved.enabled).toBe(true);
		expect(saved).not.toHaveProperty('attention');
		expect(saved).not.toHaveProperty('legacy');
	});

	it('never takes the server’s own fields from a draft, even one that skipped parseRule', () => {
		const smuggled = {
			...draft('one'),
			attention: 'split',
			note: { splitInto: 2 },
			legacy: { enabled: true, logic: 'allof', conditions: [], actions: [] },
			id: 'mine',
			position: -5,
			account_id: B
		} as unknown as RuleDraft;
		createRule(A, draft('first'));
		const made = createRule(A, smuggled);
		expect(made.id).not.toBe('mine');
		const row = getRule(A, made.id)!;
		expect(row).toMatchObject({ position: 1 });
		for (const key of ['attention', 'note', 'legacy']) expect(row).not.toHaveProperty(key);
		expect(listRules(B)).toEqual([]);

		const updated = updateRule(A, made.id, { ...smuggled, name: 'edited' } as RuleDraft, { rewrite: true })!;
		expect(updated).toMatchObject({ id: made.id, position: 1, name: 'edited' });
		for (const key of ['attention', 'note', 'legacy']) expect(updated).not.toHaveProperty(key);
		expect(getRule(A, 'mine')).toBeNull();
		expect(listRules(B)).toEqual([]);
	});

	it('renames or switches a rule touching nothing else, and never switches a flagged one on', () => {
		importRules(A, [flagged('jev'), { ...flagged('gone', { target: { kind: 'folder', mailboxId: 'GONE' } }), attention: undefined, legacy: undefined }]);
		expect(setRuleBasics(A, 'gone', { enabled: true })).toMatchObject({ enabled: true, target: { kind: 'folder', mailboxId: 'GONE' } });
		expect(setRuleBasics(A, 'gone', { name: 'Renamed' })).toMatchObject({ name: 'Renamed', enabled: true });
		expect(setRuleBasics(A, 'jev', { enabled: true, name: 'Still off' })).toMatchObject({
			name: 'Still off',
			enabled: false,
			attention: 'jev_condition'
		});
		expect(setRuleBasics(B, 'gone', { enabled: false })).toBeNull();
	});

	it('keeps a note an edit doesn’t deal with', () => {
		importRules(A, [flagged('tab', { attention: 'tab_removed', enabled: true })]);
		expect(updateRule(A, 'tab', draft('tab'))).toMatchObject({ attention: 'tab_removed' });
	});

	it('dismisses each kind of note as it should be', () => {
		importRules(A, [
			flagged('pinned', { attention: 'tab_pinned', note: { tab: { tab: 'updates' } } }),
			flagged('removed', { attention: 'tab_removed', enabled: true }),
			flagged('split', { attention: 'split', enabled: true, legacy: undefined, note: { splitInto: 2 } }),
			flagged('jev-split', { note: { splitInto: 3 } }),
			flagged('jev'),
			{ ...flagged('plain', { enabled: true }), attention: undefined, legacy: undefined }
		]);
		expect(dismissNote(A, 'pinned')).toBe('deleted');
		expect(getRule(A, 'pinned')).toBeNull();
		expect(dismissNote(A, 'removed')).toBe('cleared');
		expect(getRule(A, 'removed')).not.toHaveProperty('attention');
		expect(getRule(A, 'removed')).not.toHaveProperty('legacy');
		expect(dismissNote(A, 'split')).toBe('cleared');
		expect(getRule(A, 'split')).not.toHaveProperty('note');
		// Waiting to be rewritten: only the split note goes.
		expect(dismissNote(A, 'jev-split')).toBe('cleared');
		expect(getRule(A, 'jev-split')).toMatchObject({ attention: 'jev_condition', enabled: false });
		expect(getRule(A, 'jev-split')).not.toHaveProperty('note');
		expect(dismissNote(A, 'jev')).toBe('nothing');
		expect(dismissNote(A, 'plain')).toBe('nothing');
		expect(getRule(A, 'jev')).toMatchObject({ attention: 'jev_condition' });
	});

	it('deletes the rules that only file into a mailbox, keeps those that do more, and touches no others', () => {
		createRule(A, draft('folder', { target: { kind: 'folder', mailboxId: 'GONE' } }));
		createRule(A, draft('label', { target: { kind: 'label', mailboxId: 'GONE' } }));
		createRule(A, draft('label + read', { target: { kind: 'label', mailboxId: 'GONE' }, markRead: true }));
		createRule(A, draft('other', { target: { kind: 'folder', mailboxId: 'KEEP' } }));
		createRule(B, draft('theirs', { target: { kind: 'folder', mailboxId: 'GONE' } }));
		expect(deleteRulesForMailbox(A, 'GONE')).toEqual({ deleted: 2, kept: 1 });
		expect(names()).toEqual(['label + read', 'other']);
		expect(listRules(A)[0]).toMatchObject({ target: { kind: 'none' }, markRead: true });
		expect(names(B)).toEqual(['theirs']);
	});
});
