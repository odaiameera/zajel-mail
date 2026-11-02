import { beforeEach, describe, expect, it, vi } from 'vitest';

// A small in-memory account: which mailboxes each message is in, which
// updates the server refuses, and the reminders table.
const state = vi.hoisted(() => ({
	boxes: {} as Record<string, Record<string, boolean>>,
	refuse: new Set<string>(),
	rows: {} as Record<string, { original_mailbox_id: string }>,
	scheduled: [] as { emailId: string; original: string }[],
	deleted: [] as string[]
}));

const MAILBOXES = [
	{ id: 'IN', name: 'Inbox', role: 'inbox', parentId: null, sortOrder: 0, totalEmails: 0, unreadEmails: 0 },
	{ id: 'PRJ', name: 'Projects', role: null, parentId: null, sortOrder: 0, totalEmails: 0, unreadEmails: 0 },
	{ id: 'TR', name: 'Trash', role: 'trash', parentId: null, sortOrder: 0, totalEmails: 0, unreadEmails: 0 },
	{ id: 'LBLS', name: 'Labels', role: null, parentId: null, sortOrder: 0, totalEmails: 0, unreadEmails: 0 },
	{ id: 'WORK', name: 'Work', role: null, parentId: 'LBLS', sortOrder: 0, totalEmails: 0, unreadEmails: 0 },
	{ id: 'RML', name: 'Remind Me Later', role: null, parentId: null, sortOrder: 0, totalEmails: 0, unreadEmails: 0 }
];

vi.mock('$lib/jmap/auth', () => ({
	createClient: () => ({
		request: async ([[name, args]]: [string, Record<string, unknown>][]) => {
			if (name === 'Email/get') {
				const list = (args.ids as string[])
					.filter((id) => state.boxes[id])
					.map((id) => ({ id, mailboxIds: state.boxes[id] }));
				return { methodResponses: [['Email/get', { list, notFound: [] }, '0']], sessionState: '' };
			}
			if (name === 'Email/set') {
				const notUpdated: Record<string, { type: string }> = {};
				for (const [id, patch] of Object.entries((args.update ?? {}) as Record<string, Record<string, unknown>>)) {
					if (state.refuse.has(id)) {
						notUpdated[id] = { type: 'invalidPatch' };
						continue;
					}
					if (patch.mailboxIds) state.boxes[id] = patch.mailboxIds as Record<string, boolean>;
				}
				return { methodResponses: [['Email/set', { notUpdated }, '0']], sessionState: '' };
			}
			throw new Error(`unexpected ${name}`);
		}
	})
}));
vi.mock('$lib/jmap/mailbox', () => ({
	getMailboxes: async () => MAILBOXES,
	ensureRemindMeLaterMailbox: async () => 'RML',
	REMIND_ME_LATER_NAME: 'Remind Me Later'
}));
vi.mock('$lib/server/user', () => ({ userEmailFromAuth: () => 'me@example.test' }));
vi.mock('$lib/server/db/queries/reminders', () => ({
	scheduleReminder: (_user: string, _acct: string, emailId: string, original: string) =>
		state.scheduled.push({ emailId, original }),
	getReminder: (_user: string, emailId: string) => state.rows[emailId] ?? null,
	deleteReminder: (_user: string, emailId: string) => state.deleted.push(emailId),
	listReminders: () => []
}));

import { POST } from './+server';
import { DELETE } from './[emailId]/+server';

const locals = { auth: { accountId: 'jmap' }, activeAccountId: 'acct-1' };

async function snooze(body: Record<string, unknown>) {
	const res = await POST({
		request: new Request('http://localhost/api/reminders', { method: 'POST', body: JSON.stringify(body) }),
		locals
	} as unknown as Parameters<typeof POST>[0]);
	return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function cancel(emailId: string) {
	const res = await DELETE({ params: { emailId }, locals } as unknown as Parameters<typeof DELETE>[0]);
	return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
	state.boxes = {
		starred: { IN: true, WORK: true },
		filed: { PRJ: true },
		waiting: { RML: true, WORK: true },
		movedOn: { TR: true }
	};
	state.refuse = new Set();
	state.rows = {
		waiting: { original_mailbox_id: 'PRJ' },
		movedOn: { original_mailbox_id: 'IN' },
		refused: { original_mailbox_id: 'IN' }
	};
	state.scheduled = [];
	state.deleted = [];
});

describe('snoozing', () => {
	it('leaves every folder, keeps the labels, and remembers the folder, not the label the list named', async () => {
		// From Starred the list has no folder and named the first mailbox it saw: the label.
		const { status, body } = await snooze({ emailId: 'starred', remindAt: '2026-12-01T09:00:00Z', sourceMailboxId: 'WORK' });
		expect(status).toBe(200);
		expect(body.returnsTo).toBe('IN');
		expect(state.boxes.starred).toEqual({ RML: true, WORK: true });
		expect(state.scheduled).toEqual([{ emailId: 'starred', original: 'IN' }]);
	});

	it('works without a hint and from a folder the message is really in', async () => {
		await snooze({ emailId: 'filed', remindAt: '2026-12-01T09:00:00Z' });
		expect(state.boxes.filed).toEqual({ RML: true });
		expect(state.scheduled).toEqual([{ emailId: 'filed', original: 'PRJ' }]);
	});

	it('refuses a message already waiting, and one that is gone', async () => {
		expect((await snooze({ emailId: 'waiting', remindAt: '2026-12-01T09:00:00Z' })).status).toBe(400);
		expect((await snooze({ emailId: 'nope', remindAt: '2026-12-01T09:00:00Z' })).status).toBe(404);
		expect(state.scheduled).toEqual([]);
	});
});

describe('cancelling a reminder', () => {
	it('brings the message back first, then forgets the reminder', async () => {
		const { status, body } = await cancel('waiting');
		expect(status).toBe(200);
		expect(body.returnedTo).toBe('PRJ');
		expect(state.boxes.waiting).toEqual({ PRJ: true, WORK: true });
		expect(state.deleted).toEqual(['waiting']);
	});

	it('keeps the reminder when the server refuses the move', async () => {
		state.refuse.add('waiting');
		expect((await cancel('waiting')).status).toBe(500);
		expect(state.deleted).toEqual([]);
		expect(state.boxes.waiting).toEqual({ RML: true, WORK: true });
	});

	it('leaves a message the user moved on by hand where it is, and forgets the reminder', async () => {
		const { status, body } = await cancel('movedOn');
		expect(status).toBe(200);
		expect(body.returnedTo).toBeNull();
		expect(state.boxes.movedOn).toEqual({ TR: true });
		expect(state.deleted).toEqual(['movedOn']);
	});

	it('says so when there is no reminder', async () => {
		expect((await cancel('filed')).status).toBe(404);
	});
});
