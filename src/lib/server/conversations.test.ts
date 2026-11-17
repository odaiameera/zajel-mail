import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JMAPClient } from '$lib/jmap/client';
import type { Mailbox } from '$lib/jmap/types';

const mocks = vi.hoisted(() => ({
	on: true,
	queryAndFetchEmails: vi.fn(async () => ({ emails: [], total: 0 })),
	queryAndFetchEmailsWithFilter: vi.fn(async () => ({ emails: [], total: 0 })),
	queryThreads: vi.fn(async () => ({ emails: [], total: 0, threads: {} }))
}));

vi.mock('./db/queries/app-prefs', () => ({ conversationsOn: () => mocks.on }));
vi.mock('$lib/jmap/email', () => ({
	queryAndFetchEmails: mocks.queryAndFetchEmails,
	queryAndFetchEmailsWithFilter: mocks.queryAndFetchEmailsWithFilter
}));
vi.mock('$lib/jmap/threads', () => ({ queryThreads: mocks.queryThreads }));

import { listsConversations, loadListPage, threadScope } from './conversations';

const box = (id: string, role: string | null, name = id): Mailbox => ({ id, name, role, parentId: null }) as Mailbox;
const mailboxes = [box('in', 'inbox'), box('sent', 'sent'), box('dr', 'drafts'), box('tr', 'trash'), box('jk', 'junk'), box('work', null)];
const client = {} as JMAPClient;
const page = { position: 50, limit: 25, sort: 'date_desc' as const };

beforeEach(() => {
	mocks.on = true;
	vi.clearAllMocks();
});

describe('threadScope', () => {
	it('names the mailboxes that decide what a conversation counts', () => {
		expect(threadScope(mailboxes, 'in')).toEqual({ hereId: 'in', trashId: 'tr', junkId: 'jk', draftsId: 'dr' });
		expect(threadScope([box('in', 'inbox')], null)).toEqual({ hereId: null, trashId: null, junkId: null, draftsId: null });
	});
});

describe('loadListPage', () => {
	it('lists conversations in a mailbox, with the list\'s filter beside the mailbox', async () => {
		const hold = { after: '2026-11-16T00:00:00Z' };
		const result = await loadListPage(client, 'acct', 'u1', mailboxes, { mailbox: mailboxes[0], filter: hold, ...page });
		expect(mocks.queryThreads).toHaveBeenCalledWith(
			client,
			'acct',
			{ operator: 'AND', conditions: [{ inMailbox: 'in' }, hold] },
			{ hereId: 'in', trashId: 'tr', junkId: 'jk', draftsId: 'dr' },
			page
		);
		expect(result.threads).toEqual({});
		expect(mocks.queryAndFetchEmails).not.toHaveBeenCalled();
	});

	it('lists conversations across mailboxes for a list that is none (Starred)', async () => {
		const filter = { hasKeyword: '$flagged' };
		await loadListPage(client, 'acct', 'u1', mailboxes, { mailbox: null, filter, ...page });
		expect(mocks.queryThreads).toHaveBeenCalledWith(client, 'acct', filter, expect.objectContaining({ hereId: null }), page);
	});

	it('lists messages, exactly as before, with Conversation view off', async () => {
		mocks.on = false;
		const filter = { notKeyword: '$seen' };
		const result = await loadListPage(client, 'acct', 'u1', mailboxes, { mailbox: mailboxes[5], filter, ...page });
		expect(mocks.queryAndFetchEmails).toHaveBeenCalledWith(client, 'acct', 'work', { ...page, extraFilter: filter });
		expect(result.threads).toBeNull();
		expect(mocks.queryThreads).not.toHaveBeenCalled();
	});

	it('lists messages in Drafts whatever the setting: each is one of yours to finish', async () => {
		const result = await loadListPage(client, 'acct', 'u1', mailboxes, { mailbox: mailboxes[2], filter: null, ...page });
		expect(mocks.queryAndFetchEmails).toHaveBeenCalled();
		expect(result.threads).toBeNull();
		expect(listsConversations(mailboxes[2])).toBe(false);
		expect(listsConversations(mailboxes[0])).toBe(true);
		expect(listsConversations(null)).toBe(true);
	});
});
