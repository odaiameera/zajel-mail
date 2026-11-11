import { beforeEach, describe, expect, it, vi } from 'vitest';

// A small in-memory JMAP account: which mailboxes each message is in.
const state = vi.hoisted(() => ({
	boxes: {} as Record<string, Record<string, boolean>>,
	keywords: {} as Record<string, Record<string, boolean>>,
	destroyed: [] as string[],
	/** Messages the server refuses to change. */
	refuse: new Set<string>(),
	/** How many Email/set updates each request carried. */
	setSizes: [] as number[]
}));

vi.mock('$lib/jmap/auth', () => ({
	createClient: () => ({
		request: async ([[name, args]]: [string, Record<string, unknown>][]) => {
			if (name === 'Email/get') {
				const ids = args.ids as string[];
				const list = ids.filter((id) => state.boxes[id]).map((id) => ({ id, mailboxIds: state.boxes[id] }));
				return { methodResponses: [['Email/get', { list, notFound: [] }, '0']], sessionState: '' };
			}
			if (name === 'Email/set') {
				const notUpdated: Record<string, { type: string; description: string }> = {};
				const update = (args.update ?? {}) as Record<string, Record<string, unknown>>;
				if (args.update) state.setSizes.push(Object.keys(update).length);
				for (const [id, patch] of Object.entries(update)) {
					if (state.refuse.has(id)) {
						notUpdated[id] = { type: 'forbidden', description: 'not allowed' };
						continue;
					}
					for (const [key, value] of Object.entries(patch)) {
						if (key === 'mailboxIds') state.boxes[id] = value as Record<string, boolean>;
						else if (key.startsWith('keywords/')) (state.keywords[id] ??= {})[key.slice(9)] = value as boolean;
					}
				}
				for (const id of (args.destroy ?? []) as string[]) {
					delete state.boxes[id];
					state.destroyed.push(id);
				}
				return { methodResponses: [['Email/set', { updated: {}, notUpdated }, '0']], sessionState: '' };
			}
			throw new Error(`unexpected ${name}`);
		}
	})
}));

const MAILBOXES = [
	{ id: 'IN', name: 'Inbox', role: 'inbox', parentId: null },
	{ id: 'TR', name: 'Trash', role: 'trash', parentId: null },
	{ id: 'JK', name: 'Junk', role: 'junk', parentId: null },
	{ id: 'AR', name: 'Archive', role: 'archive', parentId: null },
	{ id: 'DR', name: 'Drafts', role: 'drafts', parentId: null },
	{ id: 'SN', name: 'Sent', role: 'sent', parentId: null },
	{ id: 'RML', name: 'Remind Me Later', role: null, parentId: null },
	{ id: 'SCH', name: 'Scheduled', role: null, parentId: null },
	{ id: 'PRJ', name: 'Projects', role: null, parentId: null },
	{ id: 'SM', name: 'Sent Messages', role: null, parentId: null },
	{ id: 'LBLS', name: 'Labels', role: null, parentId: null },
	{ id: 'WORK', name: 'Work', role: null, parentId: 'LBLS' }
];
vi.mock('$lib/jmap/mailbox', () => ({
	getMailboxes: async () => MAILBOXES,
	ensureArchiveMailbox: async () => 'AR'
}));
const corrections = vi.hoisted(() => ({ spam: vi.fn() }));
vi.mock('$lib/server/db/queries/jev-decisions', () => ({
	recordCorrections: vi.fn(),
	recordSpamCorrections: corrections.spam
}));
vi.mock('$lib/server/db/queries/jev-learning', () => ({
	recordSenderMoves: vi.fn(),
	forgetSenderMoves: vi.fn(),
	getPinCategory: vi.fn()
}));
vi.mock('$lib/server/db/queries/jev-settings', () => ({ getJevSettings: () => ({ jevEnabled: false }) }));
vi.mock('$lib/server/trust-sender', () => ({ normalizeAddress: (a: string) => a, trustSender: vi.fn() }));

import { POST } from './+server';
import { PATCH } from '../[id]/+server';
import { POST as LABEL } from '../[id]/label/+server';

const locals = { auth: { accountId: 'jmap' }, activeAccountId: 'acct-1' };

async function bulkResponse(body: Record<string, unknown>): Promise<Response> {
	return POST({
		request: new Request('http://localhost/api/email/bulk', { method: 'POST', body: JSON.stringify(body) }),
		locals
	} as unknown as Parameters<typeof POST>[0]);
}

async function bulkStatus(body: Record<string, unknown>): Promise<number> {
	return (await bulkResponse(body)).status;
}

async function singleStatus(id: string, body: Record<string, unknown>): Promise<number> {
	const res = await PATCH({
		request: new Request(`http://localhost/api/email/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
		params: { id },
		locals
	} as unknown as Parameters<typeof PATCH>[0]);
	return res.status;
}

async function bulk(body: Record<string, unknown>) {
	expect(await bulkStatus(body)).toBe(200);
}

async function single(id: string, body: Record<string, unknown>) {
	expect(await singleStatus(id, body)).toBe(200);
}

beforeEach(() => {
	state.boxes = {
		inbox1: { IN: true },
		labelled: { IN: true, WORK: true },
		filed: { PRJ: true },
		trashed: { TR: true },
		twoFolders: { IN: true, PRJ: true, WORK: true },
		labelOnly: { WORK: true }
	};
	state.keywords = {};
	state.destroyed = [];
	state.refuse = new Set();
	state.setSizes = [];
	corrections.spam.mockClear();
});

describe('moves from Starred and Search, which name no folder', () => {
	it('Trash takes the message out of its folder and keeps its labels', async () => {
		await bulk({ ids: ['inbox1', 'labelled'], action: 'trash', sourceMailboxId: '' });
		expect(state.boxes.inbox1).toEqual({ TR: true });
		expect(state.boxes.labelled).toEqual({ TR: true, WORK: true });
	});

	it('Archive, Spam and Move to… move rather than copy', async () => {
		await bulk({ ids: ['inbox1'], action: 'archive', sourceMailboxId: '' });
		expect(state.boxes.inbox1).toEqual({ AR: true });

		await bulk({ ids: ['labelled'], action: 'spam', sourceMailboxId: '' });
		expect(state.boxes.labelled).toEqual({ JK: true, WORK: true });
		expect(state.keywords.labelled).toEqual({ $junk: true, $notjunk: false });

		await bulk({ ids: ['filed'], action: 'moveTo', targetMailboxId: 'AR', sourceMailboxId: '' });
		expect(state.boxes.filed).toEqual({ AR: true });
	});

	it('the single-message actions do the same', async () => {
		await single('inbox1', { action: 'trash' });
		expect(state.boxes.inbox1).toEqual({ TR: true });
		await single('labelled', { action: 'archive', sourceMailboxId: 'WORK' });
		expect(state.boxes.labelled).toEqual({ AR: true, WORK: true });
	});
});

describe('Trash on a message already in Trash', () => {
	it('changes nothing without `permanent`, whatever folder the view names', async () => {
		// B1: an older client, or a label, Search or Starred view, naming Trash.
		await single('trashed', { action: 'trash', sourceMailboxId: 'TR' });
		await bulk({ ids: ['trashed'], action: 'trash', sourceMailboxId: 'TR' });
		expect(state.destroyed).toEqual([]);
		expect(state.boxes.trashed).toEqual({ TR: true });
	});

	it('deletes for good with `permanent`, from the single action', async () => {
		await single('trashed', { action: 'trash', permanent: true });
		expect(state.destroyed).toEqual(['trashed']);
	});

	it('deletes for good with `permanent`, from the bulk action', async () => {
		await bulk({ ids: ['trashed'], action: 'trash', permanent: true });
		expect(state.destroyed).toEqual(['trashed']);
	});

	it('moves a message not in Trash there, `permanent` or not', async () => {
		// B2: a forged or stale request never deletes mail outside Trash.
		await single('inbox1', { action: 'trash', permanent: true });
		expect(state.destroyed).toEqual([]);
		expect(state.boxes.inbox1).toEqual({ TR: true });
	});

	it('in bulk, deletes only what is really in Trash and moves the rest there', async () => {
		// B3
		await bulk({ ids: ['trashed', 'filed'], action: 'trash', permanent: true });
		expect(state.destroyed).toEqual(['trashed']);
		expect(state.boxes.filed).toEqual({ TR: true });
	});
});

describe('Undo after Trash: restore', () => {
	beforeEach(() => {
		state.boxes.binned = { TR: true, WORK: true };
	});

	it.each([
		['the Inbox', 'IN', 'IN'],
		['a folder', 'PRJ', 'PRJ'],
		['Sent', 'SN', 'SN'],
		['Drafts', 'DR', 'DR'],
		['Archive', 'AR', 'AR']
	])('puts it back in %s, labels kept', async (_name, mailboxId, lands) => {
		await single('binned', { action: 'restore', mailboxId });
		expect(state.boxes.binned).toEqual({ [lands]: true, WORK: true });
	});

	it.each([
		['Remind Me Later', 'RML'],
		['Scheduled', 'SCH'],
		['a label', 'WORK'],
		['the Labels container', 'LBLS'],
		['Trash itself', 'TR'],
		['a folder that no longer exists', 'GONE'],
		['nothing', undefined]
	])('sends it to the Inbox instead of %s', async (_name, mailboxId) => {
		await single('binned', { action: 'restore', mailboxId });
		expect(state.boxes.binned).toEqual({ IN: true, WORK: true });
	});

	it('leaves a message that is no longer in Trash alone', async () => {
		await single('labelled', { action: 'restore', mailboxId: 'PRJ' });
		expect(state.boxes.labelled).toEqual({ IN: true, WORK: true });
	});
});

describe('bulk actions that some messages refuse', () => {
	const five = ['m1', 'm2', 'm3', 'm4', 'm5'];
	beforeEach(() => {
		for (const id of five) state.boxes[id] = { IN: true };
	});

	it('writes the rest, names the refused one, and records spam corrections only for the moved', async () => {
		state.refuse.add('m3');
		const res = await bulkResponse({ ids: five, action: 'spam' });
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ failed: ['m3'] });
		expect(state.boxes.m1).toEqual({ JK: true });
		expect(state.boxes.m3).toEqual({ IN: true });
		expect(corrections.spam).toHaveBeenCalledWith('acct-1', ['m1', 'm2', 'm4', 'm5'], 'spam');
	});

	it('does the same for moves, Archive and Trash', async () => {
		state.refuse.add('m3');
		for (const body of [
			{ action: 'moveTo', targetMailboxId: 'PRJ' },
			{ action: 'archive' },
			{ action: 'trash' }
		]) {
			const res = await bulkResponse({ ids: five, ...body });
			expect(res.status).toBe(200);
			expect(await res.json()).toMatchObject({ failed: ['m3'] });
		}
		expect(state.boxes.m1).toEqual({ TR: true });
	});

	it('answers 500 when no message could be changed', async () => {
		for (const id of five) state.refuse.add(id);
		const res = await bulkResponse({ ids: five, action: 'spam' });
		expect(res.status).toBe(500);
		expect(corrections.spam).not.toHaveBeenCalled();
	});

	it('writes a large selection in more than one request', async () => {
		const many = Array.from({ length: 250 }, (_, i) => `n${i}`);
		for (const id of many) state.boxes[id] = { IN: true };
		await bulk({ ids: many, action: 'archive' });
		expect(state.setSizes.length).toBeGreaterThan(1);
		expect(Math.max(...state.setSizes)).toBeLessThanOrEqual(50);
		expect(state.setSizes.reduce((a, b) => a + b, 0)).toBe(250);
		expect(state.boxes.n249).toEqual({ AR: true });
	});
});

describe('Move to… from a folder or a label', () => {
	it('takes the message out of the place it is moved from', async () => {
		await bulk({ ids: ['filed'], action: 'moveTo', targetMailboxId: 'IN', sourceMailboxId: 'PRJ' });
		expect(state.boxes.filed).toEqual({ IN: true });
	});

	it('from a label view, files the message in the folder and keeps the label', async () => {
		// It used to leave the label and stay in the Inbox: { IN, PRJ }.
		await bulk({ ids: ['labelled'], action: 'moveTo', targetMailboxId: 'PRJ', sourceMailboxId: 'WORK' });
		expect(state.boxes.labelled).toEqual({ PRJ: true, WORK: true });
		await single('labelOnly', { action: 'moveTo', targetMailboxId: 'PRJ', sourceMailboxId: 'WORK' });
		expect(state.boxes.labelOnly).toEqual({ PRJ: true, WORK: true });
	});

	it('leaves every folder a message was in, whatever folder the view named', async () => {
		await bulk({ ids: ['twoFolders'], action: 'moveTo', targetMailboxId: 'AR', sourceMailboxId: 'IN' });
		expect(state.boxes.twoFolders).toEqual({ AR: true, WORK: true });
	});
});

describe('places mail can’t be moved into', () => {
	it('refuses the Labels container, Remind Me Later, Scheduled, Drafts, Sent and Sent Messages, and changes nothing', async () => {
		for (const target of ['LBLS', 'RML', 'SCH', 'DR', 'SN', 'SM']) {
			expect(await bulkStatus({ ids: ['inbox1'], action: 'moveTo', targetMailboxId: target })).toBe(400);
			expect(await singleStatus('filed', { action: 'moveTo', targetMailboxId: target })).toBe(400);
		}
		expect(state.boxes.inbox1).toEqual({ IN: true });
		expect(state.boxes.filed).toEqual({ PRJ: true });
	});

	it('refuses a mailbox that doesn’t exist', async () => {
		expect(await bulkStatus({ ids: ['inbox1'], action: 'moveTo', targetMailboxId: 'GONE' })).toBe(400);
		expect(state.boxes.inbox1).toEqual({ IN: true });
	});
});

describe('Move to… a label', () => {
	it('adds the label and keeps the message where it is', async () => {
		await bulk({ ids: ['inbox1', 'filed'], action: 'moveTo', targetMailboxId: 'WORK' });
		expect(state.boxes.inbox1).toEqual({ IN: true, WORK: true });
		expect(state.boxes.filed).toEqual({ PRJ: true, WORK: true });
	});

	it('does the same when the view names a folder, and from the single-message action', async () => {
		await bulk({ ids: ['inbox1'], action: 'moveTo', targetMailboxId: 'WORK', sourceMailboxId: 'IN' });
		expect(state.boxes.inbox1).toEqual({ IN: true, WORK: true });
		await single('filed', { action: 'moveTo', targetMailboxId: 'WORK', sourceMailboxId: 'PRJ' });
		expect(state.boxes.filed).toEqual({ PRJ: true, WORK: true });
	});

	it('still moves between folders when the drop names no source', async () => {
		await bulk({ ids: ['inbox1'], action: 'moveTo', targetMailboxId: 'PRJ' });
		expect(state.boxes.inbox1).toEqual({ PRJ: true });
	});
});

describe('the label endpoint', () => {
	async function label(id: string, body: Record<string, unknown>) {
		const res = await LABEL({
			request: new Request(`http://localhost/api/email/${id}/label`, { method: 'POST', body: JSON.stringify(body) }),
			params: { id },
			locals
		} as unknown as Parameters<typeof LABEL>[0]);
		expect(res.status).toBe(200);
		return (await res.json()) as { mailboxIds: Record<string, boolean> };
	}

	it('answers with where the message is now, Archive when its only label came off', async () => {
		expect((await label('labelOnly', { labelId: 'WORK', action: 'remove' })).mailboxIds).toEqual({ AR: true });
		expect((await label('inbox1', { labelId: 'WORK', action: 'apply' })).mailboxIds).toEqual({ IN: true, WORK: true });
	});
});
