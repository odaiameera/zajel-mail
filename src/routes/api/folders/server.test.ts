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
	updates: [] as Record<string, Record<string, unknown>>[]
}));

vi.mock('$lib/jmap/auth', () => ({
	createClient: () => ({
		request: async ([[name, args]]: [string, Record<string, unknown>][]) => {
			if (name === 'Mailbox/set') {
				const update = (args.update ?? {}) as Record<string, Record<string, unknown>>;
				state.updates.push(update);
				for (const [id, patch] of Object.entries(update)) {
					const box = state.boxes.find((b) => b.id === id)!;
					Object.assign(box, patch);
				}
				return { methodResponses: [['Mailbox/set', { updated: {} }, '0']], sessionState: '' };
			}
			throw new Error(`unexpected ${name}`);
		}
	})
}));
vi.mock('$lib/jmap/mailbox', () => ({
	getMailboxes: async () => state.boxes.map((b) => ({ ...b })),
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
	return { status: res.status, body: (await res.json()) as { success?: boolean; error?: string } };
}

function box(id: string, name: string, extra: Partial<(typeof state.boxes)[number]> = {}) {
	return { id, name, role: null, sortOrder: 0, totalEmails: 0, unreadEmails: 0, parentId: null, ...extra };
}

beforeEach(() => {
	state.updates = [];
	state.boxes = [
		box('IN', 'Inbox', { role: 'inbox' }),
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
