import { describe, expect, it, vi, beforeAll, beforeEach } from 'vitest';
import type { MethodCall } from '$lib/jmap/types';

/**
 * Settings → Messages end to end: what the settings page POSTs is what the
 * list loaders sort by and what the reading view is handed as its
 * mark-as-read delay.
 */

const requests: MethodCall[][] = [];
const fakeClient = {
	async request(calls: MethodCall[]) {
		requests.push(calls);
		return {
			methodResponses: calls.map((call) => [call[0], { ids: [], list: [], total: 0 }, call[2]]),
			sessionState: ''
		};
	}
};

vi.mock('$lib/jmap/auth', () => ({ createClient: () => fakeClient }));
vi.mock('$lib/jmap/mailbox', async (orig) => ({
	...(await orig<typeof import('$lib/jmap/mailbox')>()),
	getMailboxes: async () => []
}));
vi.mock('$lib/jmap/identities', () => ({ getIdentities: async () => [] }));
vi.mock('$lib/server/labels', () => ({
	listLabels: async () => [],
	migrateKeywordLabelsIfNeeded: async () => {}
}));
vi.mock('$lib/server/auth/unread-badges', () => ({ unreadBadges: async () => ({}) }));

import { getDb } from '$lib/server/db/index';
import { runMigrations } from '$lib/server/db/migrate';
import { POST as savePrefs } from '../api/preferences/mail/+server';
import { load as folderLoad } from './folder/[id]/+page.server';
import { load as flaggedLoad } from './flagged/+page.server';
import { load as inboxLoad } from './inbox/+page.server';
import { load as appLoad } from './+layout.server';

const user = { id: 'msg-u1', email: 'msg-u1@example.test' };
const auth = { accountId: 'acc', authHeader: 'Basic ' + Buffer.from('msg-u1@example.test:x').toString('base64') };
const mailbox = { id: 'mb1', name: 'Work', role: null, parentId: null };
const inbox = { id: 'in1', name: 'Inbox', role: 'inbox', parentId: null };

const cookies = { get: () => undefined, set: () => {}, delete: () => {}, getAll: () => [] };

async function save(patch: Record<string, unknown>) {
	const res = await savePrefs({
		request: new Request('http://x/api/preferences/mail', { method: 'POST', body: JSON.stringify(patch) }),
		locals: { user }
	} as never);
	return res.status;
}

function lastSort(): { property: string; isAscending: boolean }[] {
	const call = requests.at(-1)!.find(([name]) => name === 'Email/query')!;
	return (call[1] as { sort: { property: string; isAscending: boolean }[] }).sort;
}

beforeAll(() => {
	runMigrations();
	getDb().prepare(`INSERT INTO app_user (id, email, password_hash) VALUES (?, ?, 'x')`).run(user.id, user.email);
});

beforeEach(() => {
	requests.length = 0;
});

const event = (path: string, extra: Record<string, unknown> = {}) =>
	({
		locals: { user, auth, activeAccountId: null, accounts: [] },
		url: new URL(`http://x${path}`),
		cookies,
		...extra
	}) as never;

describe('Settings → Messages → Default sort', () => {
	it('lists newest first until something else is chosen', async () => {
		await folderLoad(event('/folder/mb1', { params: { id: 'mb1' }, parent: async () => ({ mailboxes: [mailbox], labels: [] }) }));
		expect(lastSort()).toEqual([{ property: 'receivedAt', isAscending: false }]);
	});

	it('sorts the folder, Inbox and Flagged lists by the saved order', async () => {
		expect(await save({ defaultSort: 'date_asc' })).toBe(200);
		await folderLoad(event('/folder/mb1', { params: { id: 'mb1' }, parent: async () => ({ mailboxes: [mailbox], labels: [] }) }));
		expect(lastSort()).toEqual([{ property: 'receivedAt', isAscending: true }]);

		expect(await save({ defaultSort: 'subject' })).toBe(200);
		await inboxLoad(event('/inbox', { parent: async () => ({ mailboxes: [inbox] }) }));
		expect(lastSort()[0]).toEqual({ property: 'subject', isAscending: true });

		expect(await save({ defaultSort: 'from' })).toBe(200);
		await flaggedLoad(event('/flagged', { parent: async () => ({ mailboxes: [inbox] }) }));
		expect(lastSort()[0]).toEqual({ property: 'from', isAscending: true });
	});

	it('refuses an order it does not know', async () => {
		expect(await save({ defaultSort: 'size' })).toBe(400);
	});
});

describe('Settings → Messages → Mark as read after', () => {
	it('hands the saved delay to every mail page, 1 s until one is saved', async () => {
		const before = (await appLoad(event('/inbox'))) as { markReadDelay: number };
		expect(before.markReadDelay).toBe(1000);

		expect(await save({ markReadDelay: 250 })).toBe(200);
		const after = (await appLoad(event('/inbox'))) as { markReadDelay: number };
		expect(after.markReadDelay).toBe(250);

		expect(await save({ markReadDelay: 0 })).toBe(200);
		expect(((await appLoad(event('/inbox'))) as { markReadDelay: number }).markReadDelay).toBe(0);
	});

	it('clamps to ten seconds and refuses what is not a number', async () => {
		expect(await save({ markReadDelay: 99_999 })).toBe(200);
		expect(((await appLoad(event('/inbox'))) as { markReadDelay: number }).markReadDelay).toBe(10_000);
		expect(await save({ markReadDelay: 'soon' })).toBe(400);
	});
});
