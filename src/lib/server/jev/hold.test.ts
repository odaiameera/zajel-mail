import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JMAPClient } from '$lib/jmap/client';
import type { Mailbox, MethodCall } from '$lib/jmap/types';

const jev = vi.hoisted(() => ({
	mode: 'live' as 'live' | 'mock' | 'off',
	settings: { inboxTabs: true, jevEnabled: true }
}));
vi.mock('./client', () => ({ jevMode: () => jev.mode }));
vi.mock('$lib/server/db/queries/jev-settings', () => ({
	getJevSettings: () => jev.settings,
	sortingEnabled: (s: { inboxTabs: boolean; jevEnabled: boolean }) => s.inboxTabs && s.jevEnabled
}));

import { heldInInbox, inboxHoldOn, withInboxHold } from './hold';
import { heldCondition, holdEndsAt } from '$lib/inbox-hold';

function fakeClient(reply: (call: MethodCall) => Record<string, unknown>) {
	const requests: MethodCall[][] = [];
	const client = {
		async request(calls: MethodCall[]) {
			requests.push(calls);
			return { methodResponses: calls.map((call) => [call[0], reply(call), call[2]]), sessionState: '' };
		}
	} as unknown as JMAPClient;
	return { client, requests };
}

const NOW = Date.parse('2026-11-10T10:00:00Z');
const RECEIVED = '2026-11-10T09:59:40Z';
const mailbox = (id: string, role: string | null, unreadEmails: number): Mailbox => ({
	id,
	name: id,
	role,
	sortOrder: 0,
	totalEmails: 50,
	unreadEmails,
	parentId: null
});

beforeEach(() => {
	jev.mode = 'live';
	jev.settings = { inboxTabs: true, jevEnabled: true };
});

describe('inboxHoldOn', () => {
	it('holds new mail only while Jev sorts the Inbox tabs', () => {
		expect(inboxHoldOn('acct')).toBe(true);
		jev.settings = { inboxTabs: false, jevEnabled: true };
		expect(inboxHoldOn('acct')).toBe(false);
		jev.settings = { inboxTabs: true, jevEnabled: false };
		expect(inboxHoldOn('acct')).toBe(false);
		// No key and no mock: nothing would ever sort it, so nothing waits.
		jev.settings = { inboxTabs: true, jevEnabled: true };
		jev.mode = 'off';
		expect(inboxHoldOn('acct')).toBe(false);
		jev.mode = 'mock';
		expect(inboxHoldOn('acct')).toBe(true);
		expect(inboxHoldOn(undefined)).toBe(false);
	});
});

describe('heldInInbox', () => {
	it('counts held unread mail and says when the oldest held message shows', async () => {
		const { client, requests } = fakeClient(([name, , tag]) =>
			tag === 'u' ? { ids: [], total: 2 } : name === 'Email/get' ? { list: [{ id: 'm1', receivedAt: RECEIVED }] } : { ids: ['m1'] }
		);

		expect(await heldInInbox(client, 'acc', 'inbox', NOW)).toEqual({ unread: 2, releaseAt: holdEndsAt(RECEIVED) });
		expect(requests).toHaveLength(1);
		const held = { operator: 'AND', conditions: [{ inMailbox: 'inbox' }, heldCondition(NOW)] };
		expect(requests[0][0][1].filter).toEqual({ operator: 'AND', conditions: [held, { notKeyword: '$seen' }] });
		expect(requests[0][1][1].filter).toEqual(held);
	});
});

describe('withInboxHold', () => {
	it('leaves held mail out of the Inbox’s unread count, and only the Inbox’s', async () => {
		const { client } = fakeClient(([name, , tag]) =>
			tag === 'u' ? { total: 2 } : name === 'Email/get' ? { list: [{ id: 'm1', receivedAt: RECEIVED }] } : { ids: ['m1'] }
		);
		const { mailboxes, releaseAt } = await withInboxHold(
			client,
			'acc',
			[mailbox('inbox', 'inbox', 5), mailbox('work', null, 3)],
			NOW
		);
		expect(mailboxes.map((m) => m.unreadEmails)).toEqual([3, 3]);
		expect(releaseAt).toBe(holdEndsAt(RECEIVED));
	});

	it('keeps the count as it was when the hold can’t be read', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const client = { request: () => Promise.reject(new Error('down')) } as unknown as JMAPClient;
		const list = [mailbox('inbox', 'inbox', 5)];
		expect(await withInboxHold(client, 'acc', list, NOW)).toEqual({ mailboxes: list, releaseAt: null });
	});
});
