import { describe, expect, it } from 'vitest';
import { countUnreadByCategory, EmailUpdateError, setEmailCategory } from './email';
import type { JMAPClient } from './client';
import type { MethodCall } from './types';

/** Records each request and answers it with `reply(call)` per method call. */
function fakeClient(reply: (call: MethodCall) => Record<string, unknown>) {
	const requests: MethodCall[][] = [];
	const client = {
		async request(calls: MethodCall[]) {
			requests.push(calls);
			return {
				methodResponses: calls.map((call) => [call[0], reply(call), call[2]]),
				sessionState: ''
			};
		}
	} as unknown as JMAPClient;
	return { client, requests };
}

describe('countUnreadByCategory', () => {
	it('asks for all four tabs in one request and reads each total', async () => {
		const totals: Record<string, number> = { important: 4, updates: 12, newsletters: 0, promotions: 31 };
		const { client, requests } = fakeClient((call) => ({ ids: [], total: totals[call[2]] }));

		const counts = await countUnreadByCategory(client, 'acc', 'inbox-id');

		expect(counts).toEqual({ important: 4, updates: 12, newsletters: 0, promotions: 31 });
		expect(requests).toHaveLength(1);
		const [name, args, tag] = requests[0][1];
		expect(name).toBe('Email/query');
		expect(tag).toBe('updates');
		expect(args).toMatchObject({ accountId: 'acc', limit: 0, calculateTotal: true });
		expect(args.filter).toEqual({
			operator: 'AND',
			conditions: [{ inMailbox: 'inbox-id' }, { notKeyword: '$seen' }, { hasKeyword: '$cat_updates' }]
		});
	});
});

describe('countUnreadByCategory with the Inbox hold', () => {
	it('ANDs the extra condition into every tab’s count', async () => {
		const { client, requests } = fakeClient(() => ({ ids: [], total: 0 }));
		const hold = { operator: 'OR', conditions: [{ hasKeyword: '$jev_sorted' }, { before: '2026-11-10T09:58:00Z' }] };

		await countUnreadByCategory(client, 'acc', 'inbox-id', hold);

		for (const [, args] of requests[0]) {
			expect((args.filter as { conditions: unknown[] }).conditions.at(-1)).toEqual(hold);
		}
	});
});

describe('setEmailCategory', () => {
	it('writes the same exclusive keyword patch to every email', async () => {
		const { client, requests } = fakeClient(() => ({ updated: { a: null, b: null } }));

		await setEmailCategory(client, 'acc', ['a', 'b'], 'newsletters');

		const [name, args] = requests[0][0];
		expect(name).toBe('Email/set');
		const patch = {
			'keywords/$cat_updates': false,
			'keywords/$cat_newsletters': true,
			'keywords/$cat_promotions': false
		};
		expect(args.update).toEqual({ a: patch, b: patch });
	});

	it('surfaces emails the server refused to update', async () => {
		const { client } = fakeClient(() => ({
			updated: { a: null },
			notUpdated: { b: { type: 'notFound', description: 'gone' } }
		}));

		await expect(setEmailCategory(client, 'acc', ['a', 'b'], 'updates')).rejects.toBeInstanceOf(
			EmailUpdateError
		);
	});

	it('sends nothing for an empty selection', async () => {
		const { client, requests } = fakeClient(() => ({}));
		await setEmailCategory(client, 'acc', [], 'updates');
		expect(requests).toHaveLength(0);
	});
});
