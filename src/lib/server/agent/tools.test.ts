import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JMAPClient } from '$lib/jmap/client';
import type { Mailbox } from '$lib/jmap/types';

const scheduled = vi.hoisted(() => [] as { emailId: string; origin: string }[]);
vi.mock('$lib/server/db/queries/reminders', () => ({
	scheduleReminder: (_user: string, _account: string, emailId: string, origin: string) => scheduled.push({ emailId, origin })
}));

import { AGENT_TOOLS, mailboxCache, type ToolContext } from './tools';
import { newTurnBudget } from './budget';

function box(id: string, name: string, extra: Partial<Mailbox> = {}): Mailbox {
	return { id, name, role: null, sortOrder: 0, totalEmails: 0, unreadEmails: 0, parentId: null, ...extra };
}

// The assistant's filing tools against an in-memory account, through the
// same filing code the app uses.
const state = {
	mailboxes: [] as Mailbox[],
	boxes: {} as Record<string, Record<string, boolean>>,
	sets: 0
};

const client = {
	request: async ([[name, args]]: [string, Record<string, unknown>][]) => {
		const reply = (result: unknown) => ({ methodResponses: [[name, result, '0']], sessionState: '' });
		if (name === 'Mailbox/get') return reply({ list: state.mailboxes });
		if (name === 'Email/get') {
			const list = (args.ids as string[])
				.filter((id) => state.boxes[id])
				.map((id) => ({ id, mailboxIds: state.boxes[id], subject: `About ${id}`, keywords: {} }));
			return reply({ list });
		}
		if (name === 'Email/set') {
			state.sets++;
			for (const [id, patch] of Object.entries((args.update ?? {}) as Record<string, Record<string, unknown>>)) {
				if (patch.mailboxIds) state.boxes[id] = patch.mailboxIds as Record<string, boolean>;
			}
			return reply({ notUpdated: {} });
		}
		throw new Error(`unexpected ${name}`);
	}
} as unknown as JMAPClient;

function ctx(): ToolContext {
	return {
		auth: { accountId: 'acct' } as ToolContext['auth'],
		client,
		userId: 'user-1',
		userEmail: 'me@example.test',
		accountRowId: 'row-1',
		conversationId: null,
		source: 'chat',
		timeZone: 'UTC',
		budget: newTurnBudget(),
		mailboxes: mailboxCache(client, 'acct')
	};
}

const run = (name: string, input: Record<string, unknown>) => AGENT_TOOLS.find((t) => t.name === name)!.run(ctx(), input);

beforeEach(() => {
	state.mailboxes = [
		box('IN', 'Inbox', { role: 'inbox' }),
		box('AR', 'Archive', { role: 'archive' }),
		box('DR', 'Drafts', { role: 'drafts' }),
		box('RML', 'Remind Me Later'),
		box('SCH', 'Scheduled'),
		box('PRJ', 'Projects'),
		box('B', 'Bills'),
		box('LBLS', 'Labels'),
		box('WORK', 'Work', { parentId: 'LBLS' })
	];
	state.boxes = {
		e1: { IN: true, B: true, WORK: true },
		labelOnly: { WORK: true }
	};
	state.sets = 0;
	scheduled.length = 0;
});

describe('list_folders', () => {
	it('says which mailboxes are folders, which are labels, and which are for neither', async () => {
		const lines = (await run('list_folders', {})).content.split('\n');
		expect(lines).toEqual([
			'id=IN | folder | Inbox (inbox)',
			'id=DR | not for filing | Drafts (drafts)',
			'id=AR | folder | Archive (archive)',
			'id=RML | not for filing | Remind Me Later',
			'id=SCH | not for filing | Scheduled',
			'id=PRJ | folder | Projects',
			'id=B | folder | Bills',
			'id=LBLS | not for filing | Labels',
			'id=WORK | label | Work'
		]);
	});
});

describe('move_to_folder', () => {
	it('refuses the Labels container, a label, Remind Me Later, Scheduled and Drafts', async () => {
		for (const folder_id of ['LBLS', 'WORK', 'RML', 'SCH', 'DR']) {
			const result = await run('move_to_folder', { email_ids: ['e1'], folder_id });
			expect(result.isError).toBe(true);
		}
		expect(state.sets).toBe(0);
	});

	it('moves out of every folder and keeps the labels', async () => {
		const result = await run('move_to_folder', { email_ids: ['e1'], folder_id: 'PRJ' });
		expect(result.done).toBe('Moved 1 message to Projects');
		expect(state.boxes.e1).toEqual({ PRJ: true, WORK: true });
	});
});

describe('set_label', () => {
	it('sends a message whose only label comes off to Archive', async () => {
		await run('set_label', { email_ids: ['labelOnly'], label_id: 'WORK', on: false });
		expect(state.boxes.labelOnly).toEqual({ AR: true });
	});

	it('adds a label without moving the message', async () => {
		state.boxes.e2 = { PRJ: true };
		await run('set_label', { email_ids: ['e2'], label_id: 'WORK', on: true });
		expect(state.boxes.e2).toEqual({ PRJ: true, WORK: true });
	});
});

describe('snooze', () => {
	it('takes the message out of every folder, as the app’s snooze does, and keeps its labels', async () => {
		const result = await run('snooze', { email_id: 'e1', until: '2099-01-01T09:00' });
		expect(result.isError).toBeUndefined();
		expect(state.boxes.e1).toEqual({ RML: true, WORK: true });
		expect(scheduled).toEqual([{ emailId: 'e1', origin: 'IN' }]);
	});

	it('snoozes a message that is only in a label, coming back to the Inbox', async () => {
		await run('snooze', { email_id: 'labelOnly', until: '2099-01-01T09:00' });
		expect(state.boxes.labelOnly).toEqual({ RML: true, WORK: true });
		expect(scheduled).toEqual([{ emailId: 'labelOnly', origin: 'IN' }]);
	});
});
