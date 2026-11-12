import { beforeEach, describe, expect, it, vi } from 'vitest';

// An in-memory account's mailboxes; Mailbox/set updates land on them.
const state = vi.hoisted(() => ({
	boxes: [] as Array<{
		id: string;
		name: string;
		role: string | null;
		sortOrder: number;
		totalEmails: number;
		unreadEmails: number;
		parentId: string | null;
	}>,
	updates: [] as Record<string, Record<string, unknown>>[],
	/** Every Mailbox/set: what was asked of the mail server. */
	sets: [] as Record<string, unknown>[],
	made: 0,
	/** The account's messages: the mailboxes each is in. */
	mail: {} as Record<string, Record<string, boolean>>
}));
const rules = vi.hoisted(() => ({ deleteRulesForMailbox: vi.fn(() => ({ deleted: 0, kept: 0 })) }));
const pipeline = vi.hoisted(() => ({ refreshPipeline: vi.fn() }));
const meta = vi.hoisted(() => ({ deleteMailboxMeta: vi.fn(), setMailboxMeta: vi.fn() }));
vi.mock('$lib/server/rules/store', () => rules);
vi.mock('$lib/server/mail-pipeline', () => pipeline);
vi.mock('$lib/server/db/queries/mailbox-meta', () => meta);

vi.mock('$lib/jmap/auth', () => ({
	createClient: () => ({
		request: async ([[name, args]]: [string, Record<string, unknown>][]) => {
			if (name === 'Mailbox/get') {
				return { methodResponses: [['Mailbox/get', { list: state.boxes.map((b) => ({ ...b })) }, '0']], sessionState: '' };
			}
			if (name === 'Email/query') {
				const inMailbox = (args.filter as { inMailbox: string }).inMailbox;
				const ids = Object.keys(state.mail).filter((id) => state.mail[id][inMailbox]);
				return { methodResponses: [['Email/query', { ids }, '0']], sessionState: '' };
			}
			if (name === 'Email/get') {
				const list = (args.ids as string[]).map((id) => ({ id, mailboxIds: { ...state.mail[id] } }));
				return { methodResponses: [['Email/get', { list }, '0']], sessionState: '' };
			}
			if (name === 'Email/set') {
				for (const [id, patch] of Object.entries(args.update as Record<string, { mailboxIds: Record<string, boolean> }>)) {
					state.mail[id] = { ...patch.mailboxIds };
				}
				return { methodResponses: [['Email/set', { updated: {} }, '0']], sessionState: '' };
			}
			if (name === 'Mailbox/set') {
				state.sets.push(args);
				const created: Record<string, { id: string }> = {};
				for (const [key, box] of Object.entries((args.create ?? {}) as Record<string, { name: string; parentId: string | null }>)) {
					const id = `NEW${++state.made}`;
					state.boxes.push({ id, name: box.name, role: null, sortOrder: 0, totalEmails: 0, unreadEmails: 0, parentId: box.parentId });
					created[key] = { id };
				}
				// As a real server does: a mailbox with mail in it isn't destroyed.
				const asked = (args.destroy ?? []) as string[];
				const full = (id: string) => Object.values(state.mail).some((m) => m[id]);
				const destroyed = asked.filter((id) => !full(id));
				const notDestroyed = Object.fromEntries(asked.filter(full).map((id) => [id, { type: 'mailboxHasEmail' }]));
				state.boxes = state.boxes.filter((b) => !destroyed.includes(b.id));
				const update = (args.update ?? {}) as Record<string, Record<string, unknown>>;
				if (args.update) state.updates.push(update);
				for (const [id, patch] of Object.entries(update)) {
					const box = state.boxes.find((b) => b.id === id)!;
					Object.assign(box, patch);
				}
				return { methodResponses: [['Mailbox/set', { updated: {}, created, destroyed, notDestroyed }, '0']], sessionState: '' };
			}
			throw new Error(`unexpected ${name}`);
		}
	})
}));
vi.mock('$lib/jmap/mailbox', () => ({
	getMailboxes: async () => state.boxes.map((b) => ({ ...b })),
	ensureArchiveMailbox: async () => 'AR',
	REMIND_ME_LATER_NAME: 'Remind Me Later',
	isScheduledMailbox: (m: { role: string | null; parentId: string | null; name: string }) =>
		m.role === 'scheduled' || (m.role === null && m.parentId === null && m.name === 'Scheduled')
}));

import { POST } from './+server';

const locals = { auth: { accountId: 'jmap' }, activeAccountId: 'acct-1' };

async function post(body: Record<string, unknown>) {
	const res = await POST({
		request: new Request('http://localhost/api/folders', { method: 'POST', body: JSON.stringify(body) }),
		locals
	} as unknown as Parameters<typeof POST>[0]);
	return {
		status: res.status,
		body: (await res.json()) as { success?: boolean; error?: string; id?: string; rulesDeleted?: number; rulesKept?: number }
	};
}

function box(id: string, name: string, extra: Partial<(typeof state.boxes)[number]> = {}) {
	return { id, name, role: null, sortOrder: 0, totalEmails: 0, unreadEmails: 0, parentId: null, ...extra };
}

beforeEach(() => {
	state.updates = [];
	state.sets = [];
	state.mail = {};
	vi.clearAllMocks();
	rules.deleteRulesForMailbox.mockReturnValue({ deleted: 0, kept: 0 });
	state.boxes = [
		box('IN', 'Inbox', { role: 'inbox' }),
		box('RML', 'Remind Me Later'),
		box('SCH', 'Scheduled'),
		box('LBLS', 'Labels'),
		box('WORK', 'Work', { parentId: 'LBLS' }),
		box('HOME', 'Home', { parentId: 'LBLS' }),
		box('A', 'Alpha'),
		box('B', 'Beta'),
		box('P', 'Projects'),
		box('P1', 'Child', { parentId: 'P' })
	];
});

describe('POST /api/folders reorder', () => {
	it('renumbers the level in one Mailbox/set and nests where asked', async () => {
		const { status, body } = await post({ action: 'reorder', id: 'P', parentId: null, beforeId: 'A' });
		expect(status).toBe(200);
		expect(body.success).toBe(true);
		expect(state.updates).toEqual([
			{
				P: { parentId: null, sortOrder: 10 },
				A: { parentId: null, sortOrder: 20 },
				B: { parentId: null, sortOrder: 30 }
			}
		]);

		await post({ action: 'reorder', id: 'A', parentId: 'P', beforeId: 'P1' });
		expect(state.boxes.find((b) => b.id === 'A')).toMatchObject({ parentId: 'P', sortOrder: 10 });
		expect(state.boxes.find((b) => b.id === 'P1')).toMatchObject({ parentId: 'P', sortOrder: 20 });
	});

	it('reorders labels, which stay under Labels', async () => {
		expect((await post({ action: 'reorder', id: 'HOME', parentId: 'LBLS', beforeId: 'WORK' })).status).toBe(200);
		expect(state.boxes.find((b) => b.id === 'HOME')).toMatchObject({ parentId: 'LBLS', sortOrder: 10 });

		const refused = await post({ action: 'reorder', id: 'HOME', parentId: null, beforeId: null });
		expect(refused.status).toBe(400);
		expect(refused.body.error).toBe('Labels stay under Labels');
	});

	it('refuses system folders, the Labels container, cycles and label parents', async () => {
		expect((await post({ action: 'reorder', id: 'IN', parentId: null, beforeId: null })).status).toBe(403);
		expect((await post({ action: 'reorder', id: 'LBLS', parentId: null, beforeId: null })).status).toBe(404);
		expect((await post({ action: 'reorder', id: 'P', parentId: 'P1', beforeId: null })).body.error).toBe(
			'Cannot move a folder into one of its descendants'
		);
		expect((await post({ action: 'reorder', id: 'A', parentId: 'WORK', beforeId: null })).body.error).toBe(
			'Cannot nest folders under labels'
		);
		expect((await post({ action: 'reorder', id: 'A', parentId: 'P', beforeId: 'B' })).body.error).toBe(
			'That folder is not at the destination'
		);
		expect(state.updates).toEqual([]);
	});
});

describe('POST /api/folders and the app’s own folders', () => {
	it('won’t rename, move, reorder or delete Remind Me Later or Scheduled', async () => {
		for (const id of ['RML', 'SCH']) {
			expect((await post({ action: 'rename', id, name: 'Later' })).status).toBe(403);
			expect((await post({ action: 'move', id, newParentId: 'P' })).status).toBe(403);
			expect((await post({ action: 'reorder', id, parentId: 'P', beforeId: null })).status).toBe(403);
			expect((await post({ action: 'delete', id })).status).toBe(403);
		}
		expect(state.updates).toEqual([]);
	});
});

describe('POST /api/folders for labels', () => {
	it('creates a label under Labels', async () => {
		const { status, body } = await post({ action: 'create', kind: 'label', name: '  Travel ' });
		expect(status).toBe(200);
		expect(body.success).toBe(true);
		expect(state.boxes.find((b) => b.id === body.id)).toMatchObject({ name: 'Travel', parentId: 'LBLS' });
	});

	it('makes the Labels container first when the account has none', async () => {
		state.boxes = state.boxes.filter((b) => !['LBLS', 'WORK', 'HOME'].includes(b.id));
		const { status, body } = await post({ action: 'create', kind: 'label', name: 'Travel' });
		expect(status).toBe(200);
		const container = state.boxes.find((b) => b.name === 'Labels');
		expect(container).toMatchObject({ parentId: null, role: null });
		expect(state.boxes.find((b) => b.id === body.id)).toMatchObject({ name: 'Travel', parentId: container!.id });
	});

	it('refuses a label with no name', async () => {
		expect(await post({ action: 'create', kind: 'label', name: '  ' })).toMatchObject({ status: 400, body: { error: 'Name is required' } });
		expect(state.sets).toEqual([]);
	});

	it('renames a label, and its own name shows from then on', async () => {
		const { status } = await post({ action: 'rename', id: 'WORK', name: ' Office ' });
		expect(status).toBe(200);
		expect(state.boxes.find((b) => b.id === 'WORK')).toMatchObject({ name: 'Office', parentId: 'LBLS' });
		expect(meta.setMailboxMeta).toHaveBeenCalledWith('acct-1', 'WORK', { displayName: null });
	});

	it('deletes a label, its color and icon, and says what became of its rules', async () => {
		rules.deleteRulesForMailbox.mockReturnValue({ deleted: 1, kept: 2 });
		const { status, body } = await post({ action: 'delete', id: 'WORK' });
		expect(status).toBe(200);
		expect(body).toMatchObject({ success: true, rulesDeleted: 1, rulesKept: 2 });
		expect(state.boxes.some((b) => b.id === 'WORK')).toBe(false);
		expect(state.sets).toContainEqual(expect.objectContaining({ destroy: ['WORK'], onDestroyRemoveEmails: false }));
		expect(rules.deleteRulesForMailbox).toHaveBeenCalledWith('acct-1', 'WORK');
		expect(meta.deleteMailboxMeta).toHaveBeenCalledWith('acct-1', 'WORK');
		expect(pipeline.refreshPipeline).toHaveBeenCalledTimes(1);
	});

	it('keeps a deleted label’s mail: a message only in the label goes to Archive', async () => {
		state.mail = { onlyLabel: { WORK: true }, alsoInbox: { IN: true, WORK: true } };
		const { status } = await post({ action: 'delete', id: 'WORK' });
		expect(status).toBe(200);
		expect(state.mail).toEqual({ onlyLabel: { AR: true }, alsoInbox: { IN: true } });
		expect(state.boxes.some((b) => b.id === 'WORK')).toBe(false);
	});

	it('leaves the pipeline alone when deleting a label changed no rule', async () => {
		const { body } = await post({ action: 'delete', id: 'HOME' });
		expect(body).toMatchObject({ success: true, rulesDeleted: 0, rulesKept: 0 });
		expect(pipeline.refreshPipeline).not.toHaveBeenCalled();
	});

	it('refuses a label the active account doesn’t have', async () => {
		expect((await post({ action: 'rename', id: 'THEIRS', name: 'Mine now' })).status).toBe(404);
		expect((await post({ action: 'delete', id: 'THEIRS' })).status).toBe(404);
		expect(state.sets).toEqual([]);
		expect(rules.deleteRulesForMailbox).not.toHaveBeenCalled();
	});

	it('keeps the Labels container: no rename, no delete', async () => {
		expect((await post({ action: 'rename', id: 'LBLS', name: 'Tags' })).status).toBe(400);
		expect((await post({ action: 'delete', id: 'LBLS' })).status).toBe(400);
		// Even with no labels left in it.
		state.boxes = state.boxes.filter((b) => b.parentId !== 'LBLS');
		expect((await post({ action: 'delete', id: 'LBLS' })).status).toBe(400);
		expect(state.sets).toEqual([]);
	});
});
