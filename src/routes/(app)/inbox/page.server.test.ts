import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MethodCall } from '$lib/jmap/types';

const state = vi.hoisted(() => ({
	requests: [] as MethodCall[][],
	tabs: true,
	hold: true
}));

vi.mock('$lib/jmap/auth', () => ({
	createClient: () => ({
		async request(calls: MethodCall[]) {
			state.requests.push(calls);
			return {
				methodResponses: calls.map(([name, , tag]) => [name, name === 'Email/get' ? { list: [] } : { ids: [], total: 0 }, tag]),
				sessionState: ''
			};
		}
	})
}));
vi.mock('$lib/server/user', () => ({ userEmailFromAuth: () => 'me@example.test' }));
vi.mock('$lib/server/db/queries/app-prefs', () => ({ getDefaultPageSize: () => 50, getDefaultSort: () => 'date_desc' }));
vi.mock('$lib/server/db/queries/reminders', () => ({ listMarkedIds: () => [] }));
vi.mock('$lib/server/db/queries/jev-settings', () => ({ getJevSettings: () => ({ inboxTabs: state.tabs }) }));
vi.mock('$lib/server/mail-pipeline/hold', () => ({ inboxHoldOn: () => state.hold }));

import { load } from './+page.server';
import { JEV_SORTED_KEYWORD } from '$lib/inbox-hold';

function run(search = '') {
	return load({
		locals: { auth: { accountId: 'acc' }, activeAccountId: 'acct-1', user: { id: 'user-1' } },
		url: new URL(`http://localhost/inbox${search}`),
		parent: async () => ({ mailboxes: [{ id: 'inbox', role: 'inbox' }] })
	} as unknown as Parameters<typeof load>[0]);
}

/** Every Email/query filter the load sent. */
function filters(): string[] {
	return state.requests.flat().filter(([name]) => name === 'Email/query').map(([, args]) => JSON.stringify(args.filter));
}

beforeEach(() => {
	state.requests = [];
	state.tabs = true;
	state.hold = true;
});

describe('Inbox page load', () => {
	it('leaves mail Jev hasn’t sorted out of the tab and of every tab’s unread count', async () => {
		await run('?category=updates');
		// The list and the four counts.
		expect(filters()).toHaveLength(5);
		for (const filter of filters()) expect(filter).toContain(JEV_SORTED_KEYWORD);
	});

	it('holds nothing while Jev isn’t sorting the tabs', async () => {
		state.hold = false;
		await run();
		expect(filters()).toHaveLength(5);
		for (const filter of filters()) expect(filter).not.toContain(JEV_SORTED_KEYWORD);
	});

	it('holds nothing with the tabs off, where the Inbox is all of it as before', async () => {
		state.tabs = false;
		await run();
		expect(filters()).toEqual([JSON.stringify({ inMailbox: 'inbox' })]);
	});
});
