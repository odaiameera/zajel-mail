import { describe, expect, it, vi } from 'vitest';
import type { JMAPClient } from './client';
import { getThread, queryThreads } from './threads';

const scope = { hereId: 'in', trashId: 'trash', junkId: 'junk', draftsId: 'drafts' };

const mail = (id: string, threadId: string, box: string, at: string, keywords: Record<string, boolean> = { $seen: true }) => ({
	id,
	threadId,
	mailboxIds: { [box]: true },
	keywords,
	from: [{ name: id.toUpperCase(), email: `${id}@example.test` }],
	receivedAt: at,
	hasAttachment: false,
	subject: `s-${id}`,
	preview: `p-${id}`
});

const all = [
	mail('a1', 'ta', 'in', '2026-11-16T10:00:00Z'),
	mail('a2', 'ta', 'sent', '2026-11-16T11:00:00Z'),
	mail('a3', 'ta', 'in', '2026-11-16T12:00:00Z', {}),
	mail('a4', 'ta', 'trash', '2026-11-16T12:30:00Z'),
	mail('b1', 'tb', 'in', '2026-11-16T09:00:00Z', {})
];
const byId = new Map(all.map((e) => [e.id, e]));
const threadOf = (t: string) => all.filter((e) => e.threadId === t).map((e) => e.id);

/** Answers as a JMAP server would, back-references already resolved by hand. */
function fakeClient() {
	const request = vi.fn(async (calls: [string, Record<string, unknown>, string][]) => {
		const out: [string, Record<string, unknown>, string][] = [];
		for (const [name, args, tag] of calls) {
			if (name === 'Email/query') out.push([name, { ids: ['a3', 'b1'], total: 2 }, tag]);
			else if (name === 'Email/get' && args['#ids'] && (args['#ids'] as { path: string }).path === '/ids') {
				// In another order than the query's, as a server may.
				out.push([name, { list: [byId.get('b1'), byId.get('a3')] }, tag]);
			} else if (name === 'Thread/get') {
				const prior = out.find((r) => r[0] === 'Email/get')?.[1] as { list: { threadId: string }[] };
				const ids = [...new Set(prior.list.map((e) => e.threadId))];
				out.push([name, { list: ids.map((id) => ({ id, emailIds: threadOf(id) })) }, tag]);
			} else if (name === 'Email/get') {
				const ids = args.ids as string[];
				out.push([name, { list: ids.map((id) => byId.get(id)).filter(Boolean) }, tag]);
			}
		}
		return { methodResponses: out, sessionState: 's' };
	});
	return { client: { request } as unknown as JMAPClient, request };
}

describe('queryThreads', () => {
	it('asks for one message per thread and counts threads', async () => {
		const { client, request } = fakeClient();
		const result = await queryThreads(client, 'acct', { inMailbox: 'in' }, scope, { position: 0, limit: 50 });
		const [query] = request.mock.calls[0][0];
		expect(query[0]).toBe('Email/query');
		expect(query[1]).toMatchObject({ collapseThreads: true, calculateTotal: true, filter: { inMailbox: 'in' }, limit: 50 });
		expect(result.total).toBe(2);
		// Rows in the query's order, not the order the server listed them in.
		expect(result.emails.map((e) => e.id)).toEqual(['a3', 'b1']);
	});

	it('summarises each row from every message of its thread, fetching only the ones it lacks', async () => {
		const { client, request } = fakeClient();
		const { threads } = await queryThreads(client, 'acct', { inMailbox: 'in' }, scope);
		expect(threads.ta.ids).toEqual(['a1', 'a2', 'a3']);
		expect(threads.ta.idsHere).toEqual(['a1', 'a3']);
		expect(threads.ta.unreadIds).toEqual(['a3']);
		expect(threads.tb.ids).toEqual(['b1']);
		const fetched = request.mock.calls.slice(1).flatMap((c) => (c[0][0][1].ids as string[]) ?? []);
		expect(fetched.sort()).toEqual(['a1', 'a2', 'a4']);
	});
});

describe('getThread', () => {
	function reader() {
		const request = vi.fn(async (calls: [string, Record<string, unknown>, string][]) => {
			const out: [string, Record<string, unknown>, string][] = [];
			for (const [name, args, tag] of calls) {
				if (name === 'Thread/get') {
					const asked = (out[0][1] as { list: { threadId: string }[] }).list[0];
					out.push([name, { list: [{ id: asked.threadId, emailIds: threadOf(asked.threadId) }] }, tag]);
				} else {
					const ids = args.ids as string[];
					out.push([name, { list: ids.map((id) => byId.get(id)).filter(Boolean) }, tag]);
				}
			}
			return { methodResponses: out, sessionState: 's' };
		});
		return { request } as unknown as JMAPClient;
	}

	it('returns the conversation oldest first, without what is in Trash, and says how many were left out', async () => {
		const thread = await getThread(reader(), 'acct', 'a1', scope);
		expect(thread.threadId).toBe('ta');
		expect(thread.messages.map((m) => m.id)).toEqual(['a1', 'a2', 'a3']);
		expect(thread.binned).toBe(1);
	});

	it('comes with the whole of the messages that open: the unread, the last, the one asked for', async () => {
		const thread = await getThread(reader(), 'acct', 'a1', scope);
		expect(Object.keys(thread.details).sort()).toEqual(['a1', 'a3']);
	});

	it('opened from Trash, is what is in Trash', async () => {
		const thread = await getThread(reader(), 'acct', 'a4', scope);
		expect(thread.messages.map((m) => m.id)).toEqual(['a4']);
	});

	it('is a conversation of one for a message on its own', async () => {
		const thread = await getThread(reader(), 'acct', 'b1', scope);
		expect(thread.messages.map((m) => m.id)).toEqual(['b1']);
		expect(thread.binned).toBe(0);
	});
});
