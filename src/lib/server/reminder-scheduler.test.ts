import { beforeEach, describe, expect, it, vi } from 'vitest';

// A small in-memory account: which mailboxes each message is in, and what
// the server refuses.
const state = vi.hoisted(() => ({
	boxes: {} as Record<string, Record<string, boolean>>,
	keywords: {} as Record<string, Record<string, boolean>>,
	refuse: new Set<string>(),
	due: [] as {
		id: number;
		user_email: string;
		account_id: string;
		jmap_email_id: string;
		original_mailbox_id: string;
		remind_at: string;
		created_at: string;
	}[],
	deleted: [] as string[],
	returned: [] as string[]
}));

const MAILBOXES = [
	{ id: 'IN', name: 'Inbox', role: 'inbox', parentId: null },
	{ id: 'PRJ', name: 'Projects', role: null, parentId: null },
	{ id: 'RML', name: 'Remind Me Later', role: null, parentId: null }
];

vi.mock('$lib/jmap/auth', () => ({
	createClient: () => ({
		request: async ([[name, args]]: [string, Record<string, unknown>][]) => {
			if (name === 'Mailbox/get') {
				return { methodResponses: [['Mailbox/get', { list: MAILBOXES }, '0']], sessionState: '' };
			}
			if (name === 'Email/get') {
				const list = (args.ids as string[])
					.filter((id) => state.boxes[id])
					.map((id) => ({ id, mailboxIds: state.boxes[id] }));
				return { methodResponses: [['Email/get', { list }, '0']], sessionState: '' };
			}
			if (name === 'Email/set') {
				const notUpdated: Record<string, { type: string }> = {};
				for (const [id, patch] of Object.entries(args.update as Record<string, Record<string, unknown>>)) {
					if (state.refuse.has(id)) {
						notUpdated[id] = { type: 'invalidPatch' };
						continue;
					}
					for (const [key, value] of Object.entries(patch)) {
						if (key === 'mailboxIds') state.boxes[id] = value as Record<string, boolean>;
						else if (key.startsWith('keywords/')) (state.keywords[id] ??= {})[key.slice(9)] = value as boolean;
					}
				}
				return { methodResponses: [['Email/set', { notUpdated }, '0']], sessionState: '' };
			}
			throw new Error(`unexpected ${name}`);
		}
	})
}));
vi.mock('./auth/accounts', () => ({ listSchedulableAuths: () => [], markNeedsReauth: vi.fn() }));
vi.mock('./db/queries/reminders', () => ({
	listDueReminders: () => state.due,
	deleteReminder: (_user: string, id: string) => state.deleted.push(id),
	markReturned: (_user: string, id: string) => state.returned.push(id),
	cleanupOldMarkers: vi.fn()
}));

import type { AuthState } from '$lib/jmap/types';
import { processDueRemindersForUser } from './reminder-scheduler';

const auth = { accountId: 'jmap' } as AuthState;
const reminder = (emailId: string, original: string) => ({
	id: state.due.length + 1,
	user_email: 'me@example.test',
	account_id: 'jmap',
	jmap_email_id: emailId,
	original_mailbox_id: original,
	remind_at: '2026-11-01T09:00:00Z',
	created_at: '2026-10-31T09:00:00Z'
});

beforeEach(() => {
	state.boxes = { e1: { RML: true }, e2: { RML: true }, e3: { RML: true } };
	state.keywords = {};
	state.refuse = new Set();
	state.due = [];
	state.deleted = [];
	state.returned = [];
	vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('returning a reminder', () => {
	it('moves the message back to its folder, unread, and then forgets the reminder', async () => {
		state.due = [reminder('e1', 'PRJ')];
		await processDueRemindersForUser(auth, 'me@example.test');
		expect(state.boxes.e1).toEqual({ PRJ: true });
		expect(state.keywords.e1).toEqual({ $seen: false });
		expect(state.returned).toEqual(['e1']);
		expect(state.deleted).toEqual(['e1']);
	});

	it('keeps the reminder when the server refuses the move, and carries on with the rest', async () => {
		state.refuse.add('e1');
		state.due = [reminder('e1', 'PRJ'), reminder('e2', 'PRJ')];
		await processDueRemindersForUser(auth, 'me@example.test');
		expect(state.boxes.e1).toEqual({ RML: true });
		expect(state.deleted).toEqual(['e2']);
		expect(state.returned).toEqual(['e2']);
	});

	it('returns to the Inbox when the original folder has gone', async () => {
		state.due = [reminder('e3', 'deleted-folder')];
		await processDueRemindersForUser(auth, 'me@example.test');
		expect(state.boxes.e3).toEqual({ IN: true });
		expect(state.deleted).toEqual(['e3']);
	});

	it('leaves a message the user already moved on where it is, and forgets the reminder', async () => {
		// Trashed by hand while it waited: returning it would pull it out of Trash, unread.
		state.boxes.e1 = { TR: true };
		state.due = [reminder('e1', 'IN')];
		await processDueRemindersForUser(auth, 'me@example.test');
		expect(state.boxes.e1).toEqual({ TR: true });
		expect(state.keywords.e1).toBeUndefined();
		expect(state.deleted).toEqual(['e1']);
		expect(state.returned).toEqual([]);
	});

	it('forgets a reminder whose message no longer exists', async () => {
		state.due = [reminder('gone', 'PRJ')];
		await processDueRemindersForUser(auth, 'me@example.test');
		expect(state.deleted).toEqual(['gone']);
		expect(state.returned).toEqual([]);
	});
});
