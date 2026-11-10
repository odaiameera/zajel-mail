import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MethodCall } from '$lib/jmap/types';

/**
 * The app layout's part in the Inbox's hold on new mail: the sidebar's
 * Inbox badge (and the new-mail alert that watches it) leaves out what the
 * Inbox tabs are still holding for Jev, and the page is told when to look
 * again.
 */

const state = vi.hoisted(() => ({
	hold: true,
	heldUnread: 2,
	oldestHeld: null as string | null,
	mailboxGate: null as Promise<void> | null,
	requests: [] as MethodCall[][]
}));

vi.mock('$lib/jmap/auth', () => ({
	createClient: () => ({
		async request(calls: MethodCall[]) {
			state.requests.push(calls);
			return {
				methodResponses: calls.map(([name, , tag]) => [
					name,
					tag === 'u'
						? { ids: [], total: state.heldUnread }
						: name === 'Email/get'
							? { list: state.oldestHeld ? [{ id: 'm1', receivedAt: state.oldestHeld }] : [] }
							: { ids: [] },
					tag
				]),
				sessionState: ''
			};
		}
	})
}));
vi.mock('$lib/jmap/mailbox', async (orig) => ({
	...(await orig<typeof import('$lib/jmap/mailbox')>()),
	getMailboxes: async () => {
		if (state.mailboxGate) await state.mailboxGate;
		return mailboxList();
	}
}));
const mailboxList = () => [
		{ id: 'in1', name: 'Inbox', role: 'inbox', parentId: null, unreadEmails: 7, totalEmails: 9, sortOrder: 0 },
		{ id: 'mb1', name: 'Work', role: null, parentId: null, unreadEmails: 3, totalEmails: 3, sortOrder: 1 }
	];
vi.mock('$lib/jmap/identities', () => ({ getIdentities: async () => [] }));
vi.mock('$lib/server/labels', () => ({ listLabels: async () => [], migrateKeywordLabelsIfNeeded: async () => {} }));
vi.mock('$lib/server/auth/unread-badges', () => ({ unreadBadges: async () => ({}) }));
vi.mock('$lib/server/jev/hold', async (orig) => ({
	...(await orig<typeof import('$lib/server/jev/hold')>()),
	inboxHoldOn: () => state.hold
}));

import { getDb } from '$lib/server/db/index';
import { runMigrations } from '$lib/server/db/migrate';
import { forgetInboxHolds } from '$lib/server/jev/hold';
import { INBOX_HOLD_MS } from '$lib/inbox-hold';
import { load } from './+layout.server';

const user = { id: 'hold-u1', email: 'hold-u1@example.test' };
const auth = { accountId: 'acc', authHeader: 'Basic ' + Buffer.from('hold-u1@example.test:x').toString('base64') };
const cookies = { get: () => undefined, set: () => {}, delete: () => {}, getAll: () => [] };

type Loaded = { mailboxes: { id: string; unreadEmails: number }[]; inboxHoldEndsIn: number | null };
const run = async () =>
	(await load({
		locals: { user, auth, activeAccountId: 'acct-hold', accounts: [] },
		url: new URL('http://x/inbox'),
		cookies
	} as never)) as Loaded;
const unread = (data: Loaded) => Object.fromEntries(data.mailboxes.map((m) => [m.id, m.unreadEmails]));
const holdQueries = () => state.requests.filter((calls) => calls.some(([, , tag]) => tag === 'u'));

beforeAll(() => {
	runMigrations();
	getDb().prepare(`INSERT INTO app_user (id, email, password_hash) VALUES (?, ?, 'x')`).run(user.id, user.email);
});

beforeEach(() => {
	state.hold = true;
	state.heldUnread = 2;
	state.oldestHeld = null;
	state.requests = [];
	state.mailboxGate = null;
	forgetInboxHolds();
});

describe('the layout and the Inbox hold', () => {
	it('leaves held mail out of the Inbox badge, and only the Inbox’s', async () => {
		expect(unread(await run())).toEqual({ in1: 5, mb1: 3 });
	});

	it('counts the whole Inbox where nothing is held', async () => {
		state.hold = false;
		const data = await run();
		expect(unread(data)).toEqual({ in1: 7, mb1: 3 });
		expect(data.inboxHoldEndsIn).toBeNull();
		expect(holdQueries()).toEqual([]);
	});

	it('says when to look again, never more than one hold ahead', async () => {
		state.oldestHeld = new Date(Date.now() - 30_000).toISOString();
		const soon = (await run()).inboxHoldEndsIn!;
		expect(soon).toBeGreaterThan(INBOX_HOLD_MS - 32_000);
		expect(soon).toBeLessThanOrEqual(INBOX_HOLD_MS - 29_000);

		// Dated weeks ahead: still at most one hold.
		state.oldestHeld = new Date(Date.now() + 30 * 86_400_000).toISOString();
		expect((await run()).inboxHoldEndsIn).toBe(INBOX_HOLD_MS);
	});

	it('asks about the hold alongside the mailboxes once it knows the Inbox', async () => {
		await run();
		// First load: the Inbox's id is only known once the mailboxes are in.
		expect(holdQueries()).toHaveLength(1);
		state.requests = [];
		// Later loads don't wait for the mailboxes before asking.
		let release!: () => void;
		state.mailboxGate = new Promise<void>((resolve) => (release = resolve));
		const loading = run();
		await vi.waitFor(() => expect(holdQueries()).toHaveLength(1));
		release();
		state.mailboxGate = null;
		expect(unread(await loading)).toEqual({ in1: 5, mb1: 3 });
		expect(holdQueries()).toHaveLength(1);
	});
});
