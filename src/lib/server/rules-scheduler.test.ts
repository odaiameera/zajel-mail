import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Rule } from '$lib/types/rules';

const state = vi.hoisted(() => ({
	emails: [] as Record<string, unknown>[],
	cursor: null as string | null,
	setCursors: [] as string[],
	rules: [] as unknown[]
}));

vi.mock('$lib/jmap/auth', () => ({
	createClient: () => ({
		request: async (calls: [string, Record<string, unknown>, string][]) => {
			const [name] = calls[0];
			if (name === 'Mailbox/get') {
				return {
					methodResponses: [
						['Mailbox/get', { list: [{ id: 'IN', name: 'Inbox', role: 'inbox', parentId: null }] }, '0']
					],
					sessionState: ''
				};
			}
			if (name === 'Email/query') {
				return {
					methodResponses: [
						['Email/query', { ids: state.emails.map((e) => e.id) }, 'q'],
						['Email/get', { list: state.emails }, 'g']
					],
					sessionState: ''
				};
			}
			if (name === 'Email/set') {
				return { methodResponses: [['Email/set', { updated: {} }, '0']], sessionState: '' };
			}
			throw new Error(`unexpected ${name}`);
		}
	})
}));
vi.mock('./auth/accounts', () => ({ listSchedulableAuths: () => [], markNeedsReauth: vi.fn() }));
vi.mock('./db/queries/rules', () => ({
	getRules: () => state.rules,
	getRulesCursor: () => state.cursor,
	setRulesCursor: (_user: string, iso: string) => state.setCursors.push(iso)
}));
vi.mock('./jev/rules', () => ({ jevHandlesRules: () => false }));

import type { AuthState } from '$lib/jmap/types';
import { applyRulesForUser } from './rules-scheduler';

const auth = { accountId: 'jmap' } as AuthState;

const markRead: Rule = {
	id: 'r1',
	name: 'Read',
	enabled: true,
	logic: 'allof',
	conditions: [{ id: 'c1', field: 'subject', op: 'contains', value: 'x', negate: false }],
	actions: [{ type: 'markRead' }],
	createdAt: 0
};

/** `n` Inbox messages, oldest first, stamped by `receivedAt(i)`. */
const page = (n: number, receivedAt: (i: number) => string) =>
	Array.from({ length: n }, (_, i) => ({
		id: `m${i}`,
		receivedAt: receivedAt(i),
		subject: 'x',
		from: [],
		to: [],
		mailboxIds: { IN: true },
		keywords: {},
		size: 1,
		hasAttachment: false,
		preview: ''
	}));

beforeEach(() => {
	state.emails = [];
	state.cursor = '2026-10-20T06:00:00.000Z';
	state.setCursors = [];
	state.rules = [markRead];
});

describe('the auto-apply cursor', () => {
	it('steps back a second behind a full page, so the rest of the last second is read next time', async () => {
		state.emails = page(100, (i) => (i < 99 ? '2026-10-20T07:00:00Z' : '2026-10-20T07:00:05Z'));
		await applyRulesForUser(auth, 'me@example.test', 'acct');
		expect(state.setCursors).toEqual(['2026-10-20T07:00:04.000Z']);
	});

	it('moves on when a whole page shares one second, instead of re-reading it forever', async () => {
		state.cursor = '2026-10-20T07:00:00.000Z';
		state.emails = page(100, () => '2026-10-20T07:00:00Z');
		await applyRulesForUser(auth, 'me@example.test', 'acct');
		expect(state.setCursors).toEqual(['2026-10-20T07:00:00Z']);
	});

	it('jumps to now after a partial page', async () => {
		state.emails = page(3, () => '2026-10-20T07:00:00Z');
		const before = Date.now();
		await applyRulesForUser(auth, 'me@example.test', 'acct');
		expect(Date.parse(state.setCursors[0])).toBeGreaterThanOrEqual(before);
	});
});
