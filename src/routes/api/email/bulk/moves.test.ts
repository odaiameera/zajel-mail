import { beforeEach, describe, expect, it, vi } from 'vitest';

// A small in-memory JMAP account: which mailboxes each message is in.
const state = vi.hoisted(() => ({
	boxes: {} as Record<string, Record<string, boolean>>,
	keywords: {} as Record<string, Record<string, boolean>>,
	destroyed: [] as string[]
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
				for (const [id, patch] of Object.entries((args.update ?? {}) as Record<string, Record<string, unknown>>)) {
					for (const [key, value] of Object.entries(patch)) {
						if (key === 'mailboxIds') state.boxes[id] = value as Record<string, boolean>;
						else if (key.startsWith('keywords/')) (state.keywords[id] ??= {})[key.slice(9)] = value as boolean;
					}
				}
				for (const id of (args.destroy ?? []) as string[]) {
					delete state.boxes[id];
					state.destroyed.push(id);
				}
				return { methodResponses: [['Email/set', { updated: {} }, '0']], sessionState: '' };
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
	{ id: 'PRJ', name: 'Projects', role: null, parentId: null },
	{ id: 'LBLS', name: 'Labels', role: null, parentId: null },
	{ id: 'WORK', name: 'Work', role: null, parentId: 'LBLS' }
];
vi.mock('$lib/jmap/mailbox', () => ({
	getMailboxes: async () => MAILBOXES,
	ensureArchiveMailbox: async () => 'AR'
}));
vi.mock('$lib/server/db/queries/jev-decisions', () => ({
	recordCorrections: vi.fn(),
	recordSpamCorrections: vi.fn()
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

const locals = { auth: { accountId: 'jmap' }, activeAccountId: 'acct-1' };

async function bulk(body: Record<string, unknown>) {
	const res = await POST({
		request: new Request('http://localhost/api/email/bulk', { method: 'POST', body: JSON.stringify(body) }),
		locals
	} as unknown as Parameters<typeof POST>[0]);
	expect(res.status).toBe(200);
}

async function single(id: string, body: Record<string, unknown>) {
	const res = await PATCH({
		request: new Request(`http://localhost/api/email/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
		params: { id },
		locals
	} as unknown as Parameters<typeof PATCH>[0]);
	expect(res.status).toBe(200);
}

beforeEach(() => {
	state.boxes = {
		inbox1: { IN: true },
		labelled: { IN: true, WORK: true },
		filed: { PRJ: true },
		trashed: { TR: true }
	};
	state.keywords = {};
	state.destroyed = [];
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

describe('Trash pressed in Trash', () => {
	it('destroys only what is really in Trash and moves the rest there', async () => {
		await bulk({ ids: ['trashed', 'filed'], action: 'trash', sourceMailboxId: 'TR' });
		expect(state.destroyed).toEqual(['trashed']);
		expect(state.boxes.filed).toEqual({ TR: true });

		await single('inbox1', { action: 'trash', sourceMailboxId: 'TR' });
		expect(state.destroyed).toEqual(['trashed']);
		expect(state.boxes.inbox1).toEqual({ TR: true });
	});
});

describe('Move to… from a folder or a label', () => {
	it('takes the message out of the place it is moved from', async () => {
		await bulk({ ids: ['filed'], action: 'moveTo', targetMailboxId: 'IN', sourceMailboxId: 'PRJ' });
		expect(state.boxes.filed).toEqual({ IN: true });

		await bulk({ ids: ['labelled'], action: 'moveTo', targetMailboxId: 'PRJ', sourceMailboxId: 'WORK' });
		expect(state.boxes.labelled).toEqual({ IN: true, PRJ: true });
	});
});
