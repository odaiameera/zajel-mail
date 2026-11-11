import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'zajel-rules-routes-')), 'test.db');
vi.mock('$lib/server/log', () => ({ logEvent: vi.fn(), errorFields: (e: unknown) => ({ error: String(e) }) }));
const pipeline = vi.hoisted(() => ({ refreshPipeline: vi.fn() }));
vi.mock('$lib/server/mail-pipeline', () => pipeline);

// The account's mailboxes, and a mail server that destroys what it is asked to.
const boxes = vi.hoisted(() => [
	{ id: 'IN', name: 'Inbox', role: 'inbox', parentId: null, sortOrder: 0, totalEmails: 0, unreadEmails: 0 },
	{ id: 'TR', name: 'Trash', role: 'trash', parentId: null, sortOrder: 0, totalEmails: 0, unreadEmails: 0 },
	{ id: 'RCPT', name: 'Receipts', role: null, parentId: null, sortOrder: 0, totalEmails: 0, unreadEmails: 0 },
	{ id: 'LBLS', name: 'Labels', role: null, parentId: null, sortOrder: 0, totalEmails: 0, unreadEmails: 0 },
	{ id: 'WORK', name: 'Work', role: null, parentId: 'LBLS', sortOrder: 0, totalEmails: 0, unreadEmails: 0 }
]);
vi.mock('$lib/jmap/auth', () => ({
	createClient: () => ({
		request: async ([[name, args]]: [string, Record<string, unknown>][]) => {
			if (name === 'Mailbox/get') return { methodResponses: [['Mailbox/get', { list: boxes }, '0']], sessionState: '' };
			if (name === 'Mailbox/set') return { methodResponses: [['Mailbox/set', { destroyed: args.destroy }, '0']], sessionState: '' };
			throw new Error(`unexpected ${name}`);
		}
	})
}));
vi.mock('$lib/jmap/labels', () => ({
	createLabelMailbox: vi.fn(),
	renameLabelMailbox: vi.fn(),
	deleteLabelMailbox: async () => ({ success: true })
}));
vi.mock('$lib/server/labels', () => ({
	getLabelMeta: vi.fn(),
	updateLabelMeta: vi.fn(),
	removeLabelMeta: vi.fn(),
	listLabels: async () => []
}));
vi.mock('$lib/server/user', () => ({ userEmailFromAuth: () => 'me@example.test' }));

import { getDb } from '$lib/server/db/index';
import { runMigrations } from '$lib/server/db/migrate';
import { getPinCategory } from '$lib/server/db/queries/jev-learning';
import { getRule, importRules, listRules } from '$lib/server/rules/store';
import type { Rule } from '$lib/types/rules';
import * as list from './+server';
import * as one from './[id]/+server';
import * as reorder from './reorder/+server';
import * as dismiss from './[id]/dismiss/+server';
import * as pin from './[id]/pin/+server';
import * as preview from './preview/+server';
import * as apply from './apply/+server';
import { POST as folders } from '../folders/+server';
import { POST as labels } from '../preferences/labels/+server';

const A = 'acct-a';
const B = 'acct-b';
const signedIn = (accountId = A) => ({ auth: { accountId: 'jmap' }, activeAccountId: accountId });

type Handler = (event: never) => Promise<Response> | Response;
async function call(handler: Handler, opts: { body?: unknown; id?: string; locals?: unknown } = {}) {
	const res = await handler({
		params: { id: opts.id ?? '' },
		request: new Request('http://localhost/api/rules', {
			method: 'POST',
			body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
		}),
		locals: opts.locals ?? signedIn()
	} as never);
	const text = await res.text();
	let body: Record<string, unknown> = {};
	try {
		body = JSON.parse(text);
	} catch {
		// a stream or plain text
	}
	return { status: res.status, body };
}

const draft = (name: string, over: Record<string, unknown> = {}) => ({
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

/** A rule as an upgrade leaves it. */
const stored = (id: string, over: Partial<Rule> = {}): Rule => ({
	...(draft(id) as unknown as Rule),
	id,
	position: 0,
	createdAt: 0,
	updatedAt: 0,
	...over
});

async function create(name: string, over: Record<string, unknown> = {}, accountId = A): Promise<Rule> {
	const { body } = await call(list.POST as Handler, { body: draft(name, over), locals: signedIn(accountId) });
	return body.rule as Rule;
}

beforeAll(() => {
	runMigrations();
	getDb().exec(`
		INSERT INTO app_user (id, email, password_hash) VALUES ('u1', 'u1@example.test', 'x');
		INSERT INTO mail_accounts (id, user_id, email, server_url, jmap_account_id, secret_enc) VALUES
			('${A}', 'u1', 'me@example.test', 'https://mail.example', 'j1', 'x'),
			('${B}', 'u1', 'other@example.test', 'https://mail.example', 'j2', 'x');
	`);
});

beforeEach(() => {
	getDb().prepare('DELETE FROM rules').run();
	getDb().prepare('DELETE FROM jev_sender_pins').run();
});

describe('the rules API', () => {
	it('opens or closes the new-mail event streams on every change to the rules', async () => {
		pipeline.refreshPipeline.mockClear();
		const rule = await create('Receipts');
		expect(pipeline.refreshPipeline).toHaveBeenCalledTimes(1);
		await call(one.PATCH as Handler, { id: rule.id, body: { enabled: false } });
		expect(pipeline.refreshPipeline).toHaveBeenCalledTimes(2);
		await call(one.PATCH as Handler, { id: rule.id, body: draft('Receipts', { target: { kind: 'trash' } }) });
		expect(pipeline.refreshPipeline).toHaveBeenCalledTimes(3);
		await call(reorder.POST as Handler, { body: { ids: [rule.id] } });
		expect(pipeline.refreshPipeline).toHaveBeenCalledTimes(4);
		await call(one.DELETE as Handler, { id: rule.id });
		expect(pipeline.refreshPipeline).toHaveBeenCalledTimes(5);
		// A refused save changes nothing.
		await call(list.POST as Handler, { body: draft('') });
		expect(pipeline.refreshPipeline).toHaveBeenCalledTimes(5);
	});

	it('wants a sign-in and an active account on every route', async () => {
		const handlers: Handler[] = [
			list.GET,
			list.POST,
			one.PATCH,
			one.DELETE,
			reorder.POST,
			dismiss.POST,
			pin.POST,
			preview.POST,
			apply.POST
		] as Handler[];
		for (const handler of handlers) {
			for (const locals of [{}, { auth: { accountId: 'jmap' } }]) {
				expect((await call(handler, { body: { rule: draft('x'), ids: [] }, id: 'r', locals })).status).toBe(401);
			}
		}
		expect(listRules(A)).toEqual([]);
	});

	it('creates, lists, edits and deletes, each through parseRule', async () => {
		const made = await create('Receipts', { attention: 'tab_removed', note: { splitInto: 2 } });
		expect(made).toMatchObject({ name: 'Receipts', target: { kind: 'folder', mailboxId: 'RCPT' } });
		// What only the server sets is never taken from a client.
		expect(getRule(A, made.id)).not.toHaveProperty('attention');
		expect(getRule(A, made.id)).not.toHaveProperty('note');

		const bad = await call(list.POST as Handler, { body: draft('Bad', { target: { kind: 'folder', mailboxId: 'WORK' } }) });
		expect(bad).toMatchObject({ status: 400, body: { problems: [{ field: 'target', message: '“Work” is a label, not a folder.' }] } });

		expect((await call(list.GET as Handler)).body.rules).toHaveLength(1);
		const edited = await call(one.PATCH as Handler, { id: made.id, body: { enabled: false, attention: 'tab_pinned' } });
		expect(edited.body.rule).toMatchObject({ name: 'Receipts', enabled: false });
		expect(getRule(A, made.id)).not.toHaveProperty('attention');

		expect((await call(one.DELETE as Handler, { id: made.id })).status).toBe(200);
		expect(listRules(A)).toEqual([]);
	});

	it('finds no rule of another account', async () => {
		const theirs = await create('Theirs', {}, B);
		for (const handler of [one.PATCH, one.DELETE, dismiss.POST, pin.POST] as Handler[]) {
			expect((await call(handler, { id: theirs.id, body: draft('Mine now') })).status).toBe(404);
		}
		expect(getRule(B, theirs.id)).toMatchObject({ name: 'Theirs' });
	});

	it('reorders, given exactly the account’s rule ids', async () => {
		const [a, b] = [await create('a'), await create('b')];
		const theirs = await create('theirs', {}, B);
		expect((await call(reorder.POST as Handler, { body: { ids: [b.id, a.id] } })).status).toBe(200);
		expect(listRules(A).map((r) => r.name)).toEqual(['b', 'a']);
		expect((await call(reorder.POST as Handler, { body: { ids: [b.id] } })).status).toBe(409);
		expect((await call(reorder.POST as Handler, { body: { ids: [b.id, theirs.id] } })).status).toBe(409);
		expect(listRules(A).map((r) => r.name)).toEqual(['b', 'a']);
	});

	it('refuses to switch on a flagged rule as it stands, even sent back whole, without rewrite', async () => {
		const legacy = { enabled: true, logic: 'allof' as const, conditions: [], actions: [] };
		importRules(A, [
			stored('jev', { enabled: false, attention: 'jev_condition', legacy }),
			stored('tab', { enabled: false, attention: 'tab_rule', target: { kind: 'none' } })
		]);
		for (const id of ['jev', 'tab']) {
			const res = await call(one.PATCH as Handler, { id, body: { enabled: true } });
			expect(res).toMatchObject({ status: 400, body: { error: expect.stringContaining('Save as exact rule') } });
			expect(getRule(A, id)).toMatchObject({ enabled: false });
		}
		// What is left of it, sent back as it is: still refused, still flagged.
		const remnant = getRule(A, 'jev')!;
		const resent = await call(one.PATCH as Handler, {
			id: 'jev',
			body: { enabled: true, conditions: remnant.conditions, target: remnant.target }
		});
		expect(resent.status).toBe(400);
		expect(getRule(A, 'jev')).toMatchObject({ enabled: false, attention: 'jev_condition', legacy });
	});

	it('saves a flagged rule’s edits without rewrite, leaving it flagged and off', async () => {
		importRules(A, [
			stored('jev', { enabled: false, attention: 'jev_condition', legacy: { enabled: true, logic: 'allof', conditions: [], actions: [] } })
		]);
		const renamed = await call(one.PATCH as Handler, { id: 'jev', body: { name: 'Invoices' } });
		expect(renamed.status).toBe(200);
		expect(getRule(A, 'jev')).toMatchObject({ name: 'Invoices', enabled: false, attention: 'jev_condition' });
		const edited = await call(one.PATCH as Handler, { id: 'jev', body: draft('Bills', { enabled: false, star: true }) });
		expect(edited.status).toBe(200);
		expect(getRule(A, 'jev')).toMatchObject({ name: 'Bills', star: true, enabled: false, attention: 'jev_condition' });
		expect(getRule(A, 'jev')).toHaveProperty('legacy');
	});

	it('switches a flagged rule on only as a whole rewritten rule sent with rewrite', async () => {
		importRules(A, [
			stored('jev', { enabled: false, attention: 'jev_condition', legacy: { enabled: true, logic: 'allof', conditions: [], actions: [] } }),
			stored('tab', { enabled: false, attention: 'tab_rule', target: { kind: 'none' } })
		]);
		// rewrite alone, with nothing of the rule: refused.
		expect((await call(one.PATCH as Handler, { id: 'jev', body: { rewrite: true, enabled: true } })).status).toBe(400);
		expect(getRule(A, 'jev')).toMatchObject({ enabled: false, attention: 'jev_condition' });

		const fixed = await call(one.PATCH as Handler, { id: 'jev', body: { ...draft('Invoices', { enabled: false }), rewrite: true } });
		expect(fixed.status).toBe(200);
		expect(getRule(A, 'jev')).toMatchObject({ enabled: true, name: 'Invoices' });
		expect(getRule(A, 'jev')).not.toHaveProperty('attention');
		expect(getRule(A, 'jev')).not.toHaveProperty('legacy');

		// A rewrite that doesn't hold up is refused, and nothing changes.
		const before = getRule(A, 'tab');
		const empty = await call(one.PATCH as Handler, { id: 'tab', body: { ...draft('tab', { target: { kind: 'none' } }), rewrite: true } });
		expect(empty.status).toBe(400);
		expect(getRule(A, 'tab')).toEqual(before);
	});

	it('dismisses by kind of note', async () => {
		importRules(A, [
			stored('removed', { attention: 'tab_removed' }),
			stored('split', { attention: 'split', note: { splitInto: 2 } }),
			stored('pinned', { enabled: false, attention: 'tab_pinned' }),
			stored('jev', { enabled: false, attention: 'jev_condition' })
		]);
		expect(await call(dismiss.POST as Handler, { id: 'removed' })).toMatchObject({ status: 200, body: { deleted: false } });
		expect(getRule(A, 'removed')).not.toHaveProperty('attention');
		expect((await call(dismiss.POST as Handler, { id: 'split' })).status).toBe(200);
		expect(getRule(A, 'split')).not.toHaveProperty('note');
		expect(await call(dismiss.POST as Handler, { id: 'pinned' })).toMatchObject({ status: 200, body: { deleted: true } });
		expect(getRule(A, 'pinned')).toBeNull();
		expect((await call(dismiss.POST as Handler, { id: 'jev' })).status).toBe(400);
		expect(getRule(A, 'jev')).toMatchObject({ attention: 'jev_condition' });
	});

	it('pins a flagged tab rule’s sender and deletes the rule, for that kind only', async () => {
		const tabPin = { sender: 'news@shop.example', category: 'updates' as const };
		importRules(A, [
			stored('tab', { enabled: false, attention: 'tab_rule', target: { kind: 'none' }, note: { tab: { tab: 'updates', pin: tabPin } } }),
			stored('removed', { attention: 'tab_removed', note: { tab: { tab: 'updates', pin: tabPin } } }),
			stored('nopin', { enabled: false, attention: 'tab_rule', target: { kind: 'none' }, note: { tab: { tab: 'updates' } } })
		]);
		expect(await call(pin.POST as Handler, { id: 'tab' })).toMatchObject({ status: 200, body: { pin: tabPin } });
		expect(getPinCategory(A, 'news@shop.example')).toBe('updates');
		expect(getRule(A, 'tab')).toBeNull();
		for (const id of ['removed', 'nopin']) {
			expect((await call(pin.POST as Handler, { id })).status).toBe(400);
			expect(getRule(A, id)).not.toBeNull();
		}
	});
});

describe('small edits to a rule an upgrade carried over', () => {
	const many = Array.from({ length: 21 }, (_, i) => ({ id: `c${i}`, field: 'from' as const, op: 'contains' as const, value: `x${i}`, negate: false }));
	const carriedOver = () =>
		importRules(A, [
			stored('stop-only', { target: { kind: 'none' }, stop: true }),
			stored('gone', { target: { kind: 'folder', mailboxId: 'DELETED' } }),
			stored('many', { conditions: many }),
			stored('long-name', { name: 'n'.repeat(130) }),
			stored('no-name', { name: '' })
		]);

	it('switches off any of them, leaving the rest of the rule as stored', async () => {
		carriedOver();
		for (const id of ['stop-only', 'gone', 'many', 'long-name', 'no-name']) {
			const before = getRule(A, id)!;
			const res = await call(one.PATCH as Handler, { id, body: { enabled: false } });
			expect(res.status, id).toBe(200);
			const { enabled, updatedAt: _u, ...rest } = getRule(A, id)!;
			const { updatedAt: _b, enabled: _e, ...was } = before;
			expect(enabled).toBe(false);
			expect(rest).toEqual(was);
		}
	});

	it('switches on an unflagged rule whose folder is gone', async () => {
		carriedOver();
		await call(one.PATCH as Handler, { id: 'gone', body: { enabled: false } });
		const res = await call(one.PATCH as Handler, { id: 'gone', body: { enabled: true } });
		expect(res.status).toBe(200);
		expect(getRule(A, 'gone')).toMatchObject({ enabled: true, target: { kind: 'folder', mailboxId: 'DELETED' } });
	});

	it('renames, checking only the name', async () => {
		carriedOver();
		expect(await call(one.PATCH as Handler, { id: 'many', body: { name: '' } })).toMatchObject({
			status: 400,
			body: { problems: [{ field: 'name', message: 'Give the rule a name.' }] }
		});
		expect((await call(one.PATCH as Handler, { id: 'many', body: { name: 'n'.repeat(121) } })).status).toBe(400);
		expect(await call(one.PATCH as Handler, { id: 'many', body: { name: 'New' } })).toMatchObject({ status: 200 });
		expect(getRule(A, 'many')).toMatchObject({ name: 'New', conditions: many });
	});

	it('still holds a full edit to what a new rule is held to', async () => {
		carriedOver();
		const res = await call(one.PATCH as Handler, { id: 'many', body: { name: 'Many', conditions: many } });
		expect(res).toMatchObject({ status: 400, body: { problems: [{ field: 'conditions', message: 'A rule can have at most 20 conditions.' }] } });
		expect(getRule(A, 'many')).toMatchObject({ name: 'many', conditions: many });
		const fixed = await call(one.PATCH as Handler, { id: 'many', body: { conditions: many.slice(0, 20) } });
		expect(fixed.status).toBe(200);
		expect(getRule(A, 'many')!.conditions).toHaveLength(20);
	});

	it('creates and saves a rule that only stops later rules, but not one that does nothing', async () => {
		const made = await call(list.POST as Handler, { body: draft('Stop', { target: { kind: 'none' }, stop: true }) });
		expect(made.status).toBe(200);
		const id = (made.body.rule as Rule).id;
		expect((await call(one.PATCH as Handler, { id, body: { stop: false, star: true } })).status).toBe(200);
		expect((await call(one.PATCH as Handler, { id, body: { star: false, stop: true } })).status).toBe(200);
		expect(await call(list.POST as Handler, { body: draft('Nothing', { target: { kind: 'none' } }) })).toMatchObject({
			status: 400,
			body: { problems: [{ field: 'actions' }] }
		});
		expect((await call(one.PATCH as Handler, { id, body: { stop: false } })).status).toBe(400);
	});
});

describe('deleting a folder or a label', () => {
	it('opens or closes the new-mail event streams when it changes the rules', async () => {
		pipeline.refreshPipeline.mockClear();
		await create('Receipts');
		pipeline.refreshPipeline.mockClear();
		await call(folders as Handler, { body: { action: 'delete', id: 'RCPT' } });
		expect(pipeline.refreshPipeline).toHaveBeenCalledTimes(1);
		await create('Work', { target: { kind: 'label', mailboxId: 'WORK' } });
		pipeline.refreshPipeline.mockClear();
		await call(labels as Handler, { body: { action: 'delete', id: 'WORK' } });
		expect(pipeline.refreshPipeline).toHaveBeenCalledTimes(1);
	});

	it('deletes the rules that only file into it, and says how many', async () => {
		await create('to folder');
		await create('to folder too');
		await create('to label', { target: { kind: 'label', mailboxId: 'WORK' } });
		await create('theirs', {}, B);

		const folder = await call(folders as Handler, { body: { action: 'delete', id: 'RCPT' } });
		expect(folder).toMatchObject({ status: 200, body: { success: true, rulesDeleted: 2, rulesKept: 0 } });
		expect(listRules(A).map((r) => r.name)).toEqual(['to label']);
		expect(listRules(B)).toHaveLength(1);
	});

	it('keeps a rule that also marks read, stars or stops, filing nowhere', async () => {
		const label = { kind: 'label', mailboxId: 'WORK' };
		await create('→ L', { target: label });
		await create('→ L + mark read', { target: label, markRead: true });
		await create('→ L + stop', { target: label, stop: true });
		await create('→ L + star', { target: label, star: true });

		const res = await call(labels as Handler, { body: { action: 'delete', id: 'WORK' } });
		expect(res).toMatchObject({ status: 200, body: { success: true, rulesDeleted: 1, rulesKept: 3 } });
		expect(listRules(A).map((r) => [r.name, r.target, r.markRead, r.stop, r.star])).toEqual([
			['→ L + mark read', { kind: 'none' }, true, false, false],
			['→ L + stop', { kind: 'none' }, false, true, false],
			['→ L + star', { kind: 'none' }, false, false, true]
		]);
	});
});
