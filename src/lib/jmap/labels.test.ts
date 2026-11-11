import { beforeEach, describe, expect, it } from 'vitest';
import type { JMAPClient } from './client';
import { deleteLabelMailbox } from './labels';

// An in-memory account: which mailboxes each message is in, and what was destroyed.
const state = {
	boxes: {} as Record<string, Record<string, boolean>>,
	destroyed: [] as string[],
	fallbackCalls: 0
};

const client = {
	request: async ([[name, args]]: [string, Record<string, unknown>][]) => {
		if (name === 'Email/query') {
			const inMailbox = (args.filter as { inMailbox: string }).inMailbox;
			const ids = Object.keys(state.boxes).filter((id) => state.boxes[id][inMailbox]);
			return { methodResponses: [['Email/query', { ids: ids.slice(0, args.limit as number) }, '0']], sessionState: '' };
		}
		if (name === 'Email/get') {
			const list = (args.ids as string[]).filter((id) => state.boxes[id]).map((id) => ({ id, mailboxIds: state.boxes[id] }));
			return { methodResponses: [['Email/get', { list }, '0']], sessionState: '' };
		}
		if (name === 'Email/set') {
			for (const [id, patch] of Object.entries((args.update ?? {}) as Record<string, Record<string, unknown>>)) {
				if (patch.mailboxIds) state.boxes[id] = patch.mailboxIds as Record<string, boolean>;
			}
			return { methodResponses: [['Email/set', { updated: {} }, '0']], sessionState: '' };
		}
		if (name === 'Mailbox/set') {
			const destroy = (args.destroy ?? []) as string[];
			const stillUsed = destroy.filter((mb) => Object.values(state.boxes).some((b) => b[mb]));
			const notDestroyed = Object.fromEntries(stillUsed.map((mb) => [mb, { type: 'mailboxHasEmail' }]));
			state.destroyed.push(...destroy.filter((mb) => !stillUsed.includes(mb)));
			return { methodResponses: [['Mailbox/set', { destroyed: state.destroyed, notDestroyed }, '0']], sessionState: '' };
		}
		throw new Error(`unexpected ${name}`);
	}
} as unknown as JMAPClient;

const archive = async () => {
	state.fallbackCalls++;
	return 'AR';
};

beforeEach(() => {
	state.boxes = {
		both: { IN: true, WORK: true },
		onlyLabel: { WORK: true },
		other: { IN: true, HOME: true }
	};
	state.destroyed = [];
	state.fallbackCalls = 0;
});

describe('deleteLabelMailbox', () => {
	it('takes every message out first, moving label-only mail to Archive, then destroys the empty label', async () => {
		const result = await deleteLabelMailbox(client, 'acct', 'WORK', archive);
		expect(result).toEqual({ success: true, id: 'WORK' });
		expect(state.boxes.both).toEqual({ IN: true });
		expect(state.boxes.onlyLabel).toEqual({ AR: true });
		expect(state.boxes.other).toEqual({ IN: true, HOME: true });
		expect(state.destroyed).toEqual(['WORK']);
		expect(state.fallbackCalls).toBe(1);
	});

	it('never needs the fallback for a label whose messages are all somewhere else too', async () => {
		delete state.boxes.onlyLabel;
		expect(await deleteLabelMailbox(client, 'acct', 'WORK', archive)).toEqual({ success: true, id: 'WORK' });
		expect(state.fallbackCalls).toBe(0);
	});
});
