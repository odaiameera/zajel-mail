import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JMAPClient } from '$lib/jmap/client';
import { EmailUpdateError } from '$lib/jmap/email';
import type { Mailbox } from '$lib/jmap/types';

const scheduled = vi.hoisted(() => [] as { emailId: string; origin: string; at: string }[]);
vi.mock('$lib/server/db/queries/reminders', () => ({
	scheduleReminder: (_user: string, _account: string, emailId: string, origin: string, at: string) =>
		scheduled.push({ emailId, origin, at })
}));

import {
	addLabel,
	FilingError,
	fileInto,
	markNotSpam,
	markSpam,
	moveToArchive,
	moveToFolder,
	removeLabel,
	snoozeEmail
} from './filing';

function box(id: string, name: string, extra: Partial<Mailbox> = {}): Mailbox {
	return { id, name, role: null, sortOrder: 0, totalEmails: 0, unreadEmails: 0, parentId: null, ...extra };
}

// An in-memory account: its mailboxes, which mailboxes each message is in,
// its keywords, and which messages the server refuses to change.
const state = {
	mailboxes: [] as Mailbox[],
	boxes: {} as Record<string, Record<string, boolean>>,
	keywords: {} as Record<string, Record<string, boolean>>,
	refuse: new Set<string>(),
	sets: 0
};

const client = {
	request: async ([[name, args]]: [string, Record<string, unknown>][]) => {
		const reply = (result: unknown) => ({ methodResponses: [[name, result, '0']], sessionState: '' });
		if (name === 'Mailbox/get') return reply({ list: state.mailboxes });
		if (name === 'Mailbox/set') {
			const created: Record<string, { id: string }> = {};
			for (const [key, value] of Object.entries((args.create ?? {}) as Record<string, Partial<Mailbox>>)) {
				const id = `NEW-${key}`;
				state.mailboxes.push(box(id, value.name ?? '', { role: value.role ?? null, parentId: value.parentId ?? null }));
				created[key] = { id };
			}
			return reply({ created });
		}
		if (name === 'Email/get') {
			const list = (args.ids as string[]).filter((id) => state.boxes[id]).map((id) => ({ id, mailboxIds: state.boxes[id] }));
			return reply({ list });
		}
		if (name === 'Email/set') {
			state.sets++;
			const notUpdated: Record<string, { type: string; description: string }> = {};
			for (const [id, patch] of Object.entries((args.update ?? {}) as Record<string, Record<string, unknown>>)) {
				if (state.refuse.has(id)) {
					notUpdated[id] = { type: 'invalidPatch', description: 'Invalid patch value' };
					continue;
				}
				for (const [key, value] of Object.entries(patch)) {
					if (key === 'mailboxIds') state.boxes[id] = value as Record<string, boolean>;
					else if (key.startsWith('keywords/')) (state.keywords[id] ??= {})[key.slice(9)] = value as boolean;
					else throw new Error(`unexpected patch ${key}`);
				}
			}
			return reply({ notUpdated });
		}
		throw new Error(`unexpected ${name}`);
	}
} as unknown as JMAPClient;

beforeEach(() => {
	state.mailboxes = [
		box('IN', 'Inbox', { role: 'inbox' }),
		box('AR', 'Archive', { role: 'archive' }),
		box('JK', 'Junk', { role: 'junk' }),
		box('TR', 'Trash', { role: 'trash' }),
		box('DR', 'Drafts', { role: 'drafts' }),
		box('SN', 'Sent', { role: 'sent' }),
		box('RML', 'Remind Me Later'),
		box('SCH', 'Scheduled'),
		box('PRJ', 'Projects'),
		box('B', 'Bills'),
		box('LBLS', 'Labels'),
		box('WORK', 'Work', { parentId: 'LBLS' }),
		box('HOME', 'Home', { parentId: 'LBLS' })
	];
	state.boxes = {
		inbox: { IN: true },
		labelled: { IN: true, WORK: true },
		two: { IN: true, B: true, HOME: true },
		labelOnly: { WORK: true },
		junked: { JK: true, WORK: true }
	};
	state.keywords = {};
	state.refuse = new Set();
	state.sets = 0;
	scheduled.length = 0;
});

describe('moveToFolder', () => {
	it('refuses every place that isn’t a folder, with a plain reason, and writes nothing', async () => {
		const reasons: Record<string, string> = {
			LBLS: '“Labels” holds your labels; it isn’t a folder.',
			WORK: '“Work” is a label, not a folder.',
			RML: 'Mail can’t be moved into “Remind Me Later”.',
			SCH: 'Mail can’t be moved into “Scheduled”.',
			DR: 'Mail can’t be moved into “Drafts”.',
			SN: 'Mail can’t be moved into “Sent”.',
			GONE: 'That folder no longer exists.'
		};
		for (const [target, reason] of Object.entries(reasons)) {
			const err = await moveToFolder(client, 'acct', ['inbox'], target).catch((e) => e);
			expect(err).toBeInstanceOf(FilingError);
			expect(err.message).toBe(reason);
			expect(err.status).toBe(400);
		}
		expect(state.sets).toBe(0);
		expect(state.boxes.inbox).toEqual({ IN: true });
	});

	it('moves a batch in one write: each ends up in the folder with its labels and nothing else', async () => {
		await moveToFolder(client, 'acct', ['inbox', 'labelled', 'two', 'labelOnly'], 'PRJ');
		expect(state.sets).toBe(1);
		expect(state.boxes).toMatchObject({
			inbox: { PRJ: true },
			labelled: { PRJ: true, WORK: true },
			two: { PRJ: true, HOME: true },
			labelOnly: { PRJ: true, WORK: true }
		});
	});

	it('reports each write the server refused, and each message that is gone, after writing the rest', async () => {
		state.refuse.add('labelled');
		const err = await moveToFolder(client, 'acct', ['inbox', 'labelled', 'missing'], 'B').catch((e) => e);
		expect(err).toBeInstanceOf(EmailUpdateError);
		expect(err.failures.map((f: { id: string; type: string }) => [f.id, f.type]).sort()).toEqual([
			['labelled', 'invalidPatch'],
			['missing', 'notFound']
		]);
		expect(state.boxes.inbox).toEqual({ B: true });
		expect(state.boxes.labelled).toEqual({ IN: true, WORK: true });
	});

	it('writes nothing for a message already where it is going', async () => {
		await moveToFolder(client, 'acct', ['inbox'], 'IN');
		expect(state.sets).toBe(0);
	});
});

describe('labels', () => {
	it('adds a label without moving anything', async () => {
		await addLabel(client, 'acct', ['inbox', 'two'], 'WORK');
		expect(state.boxes.inbox).toEqual({ IN: true, WORK: true });
		expect(state.boxes.two).toEqual({ IN: true, B: true, HOME: true, WORK: true });
	});

	it('refuses a folder given as a label', async () => {
		await expect(addLabel(client, 'acct', ['inbox'], 'PRJ')).rejects.toThrow(FilingError);
		await expect(removeLabel(client, 'acct', ['labelled'], 'IN')).rejects.toThrow(FilingError);
		expect(state.sets).toBe(0);
	});

	it('removes a label and leaves the folders alone', async () => {
		await removeLabel(client, 'acct', ['labelled', 'inbox'], 'WORK');
		expect(state.boxes.labelled).toEqual({ IN: true });
		expect(state.boxes.inbox).toEqual({ IN: true });
	});

	it('sends a message whose only label comes off to Archive', async () => {
		await removeLabel(client, 'acct', ['labelOnly'], 'WORK');
		expect(state.boxes.labelOnly).toEqual({ AR: true });
	});

	it('makes Archive for it when the account has none', async () => {
		state.mailboxes = state.mailboxes.filter((m) => m.id !== 'AR');
		await removeLabel(client, 'acct', ['labelOnly'], 'WORK');
		expect(state.boxes.labelOnly).toEqual({ 'NEW-arch1': true });
	});
});

describe('fileInto, the endpoints’ “Move to”', () => {
	it('adds a label when the target is a label, and moves for a folder', async () => {
		expect(await fileInto(client, 'acct', ['inbox'], 'WORK')).toBe('labelled');
		expect(state.boxes.inbox).toEqual({ IN: true, WORK: true });
		expect(await fileInto(client, 'acct', ['inbox'], 'PRJ')).toBe('moved');
		expect(state.boxes.inbox).toEqual({ PRJ: true, WORK: true });
	});

	it('refuses the Labels container and the app’s own mailboxes', async () => {
		for (const target of ['LBLS', 'RML', 'SCH']) {
			await expect(fileInto(client, 'acct', ['inbox'], target)).rejects.toThrow(FilingError);
		}
		expect(state.sets).toBe(0);
	});
});

describe('Archive, Spam and Not spam', () => {
	it('archive is a move: out of every folder, labels kept', async () => {
		await moveToArchive(client, 'acct', ['two']);
		expect(state.boxes.two).toEqual({ AR: true, HOME: true });
	});

	it('spam and not spam move and train in the same write', async () => {
		await markSpam(client, 'acct', ['labelled']);
		expect(state.sets).toBe(1);
		expect(state.boxes.labelled).toEqual({ JK: true, WORK: true });
		expect(state.keywords.labelled).toEqual({ $junk: true, $notjunk: false });

		await markNotSpam(client, 'acct', ['junked']);
		expect(state.boxes.junked).toEqual({ IN: true, WORK: true });
		expect(state.keywords.junked).toEqual({ $junk: false, $notjunk: true });
	});
});

describe('snoozeEmail', () => {
	const at = new Date('2030-01-01T09:00:00Z');

	it('leaves every folder for Remind Me Later, keeps the labels, and comes back to the folder it was in', async () => {
		const { returnsTo } = await snoozeEmail(client, 'acct', 'me@example.test', 'two', at);
		expect(state.boxes.two).toEqual({ RML: true, HOME: true });
		expect(returnsTo).toBe('IN');
		expect(scheduled).toEqual([{ emailId: 'two', origin: 'IN', at: at.toISOString() }]);
	});

	it('uses the folder the caller names only when the message is really there', async () => {
		expect((await snoozeEmail(client, 'acct', 'me', 'two', at, 'B')).returnsTo).toBe('B');
		// A label, or a folder it isn't in, is no place to come back to.
		expect((await snoozeEmail(client, 'acct', 'me', 'labelled', at, 'WORK')).returnsTo).toBe('IN');
		expect((await snoozeEmail(client, 'acct', 'me', 'inbox', at, 'PRJ')).returnsTo).toBe('IN');
	});

	it('brings a message that was only in labels back to the Inbox', async () => {
		expect((await snoozeEmail(client, 'acct', 'me', 'labelOnly', at)).returnsTo).toBe('IN');
		expect(state.boxes.labelOnly).toEqual({ RML: true, WORK: true });
	});

	it('refuses a message already snoozed, or gone, and sets no reminder', async () => {
		state.boxes.inbox = { RML: true };
		await expect(snoozeEmail(client, 'acct', 'me', 'inbox', at)).rejects.toMatchObject({ status: 400 });
		await expect(snoozeEmail(client, 'acct', 'me', 'missing', at)).rejects.toMatchObject({ status: 404 });
		expect(scheduled).toEqual([]);
	});

	it('sets no reminder when the move is refused', async () => {
		state.refuse.add('inbox');
		await expect(snoozeEmail(client, 'acct', 'me', 'inbox', at)).rejects.toThrow(EmailUpdateError);
		expect(scheduled).toEqual([]);
	});
});
