import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Rule, RuleCondition } from '$lib/types/rules';

const state = vi.hoisted(() => ({ filters: [] as unknown[] }));

vi.mock('$lib/jmap/auth', () => ({
	createClient: () => ({
		request: async (calls: [string, Record<string, unknown>, string][]) => {
			state.filters.push(calls[0][1].filter);
			return { methodResponses: [['Email/query', { total: 7 }, '0']], sessionState: '' };
		}
	})
}));

import { POST } from './+server';

async function preview(rule: unknown): Promise<{ count?: number }> {
	const res = await POST({
		request: new Request('http://localhost/api/rules/preview', { method: 'POST', body: JSON.stringify({ rule }) }),
		locals: { auth: { accountId: 'jmap' } }
	} as unknown as Parameters<typeof POST>[0]);
	return res.json();
}

const fromShop: RuleCondition = { id: 'f', field: 'from', op: 'contains', value: 'shop.example', negate: false };
const rule: Rule = {
	id: 'r1',
	name: 'Shop',
	enabled: true,
	logic: 'allof',
	conditions: [fromShop],
	actions: [{ type: 'markRead' }],
	createdAt: 0
};

beforeEach(() => {
	state.filters = [];
});

describe('the rule preview', () => {
	it('counts the mail an exact rule matches', async () => {
		expect(await preview(rule)).toEqual({ count: 7 });
		expect(state.filters).toEqual([{ from: 'shop.example' }]);
	});

	it('counts nothing for a rule waiting to be rewritten, without asking the mail server', async () => {
		expect(await preview({ ...rule, attention: 'jev_condition' })).toEqual({ count: 0 });
		expect(state.filters).toEqual([]);
	});

	it('counts nothing for a rule that still has a condition Jev judged, rather than counting its exact part', async () => {
		const jev = { id: 'j', field: 'jev', op: 'contains', value: 'it is an invoice', negate: false };
		expect(await preview({ ...rule, conditions: [fromShop, jev] })).toEqual({ count: 0 });
		expect(state.filters).toEqual([]);
	});
});
