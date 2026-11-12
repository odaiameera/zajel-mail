import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MethodCall } from '$lib/jmap/types';

const state = vi.hoisted(() => ({ hold: true, heldUnread: 2, inboxUnread: 7 }));

vi.mock('$env/dynamic/private', () => ({ env: {} }));
vi.mock('$lib/jmap/auth', () => ({
	createClient: () => ({
		async request(calls: MethodCall[]) {
			return {
				methodResponses: calls.map(([name, , tag]) => [
					name,
					tag === 'u' ? { ids: [], total: state.heldUnread } : name === 'Email/get' ? { list: [] } : { ids: [] },
					tag
				]),
				sessionState: ''
			};
		}
	})
}));
vi.mock('$lib/jmap/mailbox', () => ({
	getMailboxes: async () => [{ id: 'inbox', role: 'inbox', unreadEmails: state.inboxUnread }]
}));
vi.mock('./accounts', () => ({ authStateForAccount: () => ({ accountId: 'jmap' }) }));
vi.mock('$lib/server/mail-pipeline/hold', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/mail-pipeline/hold')>()),
	inboxHoldSince: () => (state.hold ? 0 : null)
}));

import { unreadBadges } from './unread-badges';
import type { MailAccountRow } from './accounts';

let n = 0;
/** A fresh account each time, so the badge cache never answers. */
const account = () => ({ id: `acct-${++n}`, needs_reauth: 0 }) as MailAccountRow;

beforeEach(() => {
	state.hold = true;
	state.heldUnread = 2;
	state.inboxUnread = 7;
});

describe('unreadBadges', () => {
	it('leaves out mail the other account’s Inbox is still holding for Jev', async () => {
		const other = account();
		expect(await unreadBadges([other], undefined)).toEqual({ [other.id]: 5 });
	});

	it('counts the whole Inbox where nothing is held', async () => {
		state.hold = false;
		const other = account();
		expect(await unreadBadges([other], undefined)).toEqual({ [other.id]: 7 });
	});
});
