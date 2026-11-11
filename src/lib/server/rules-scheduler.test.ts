import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Rule } from '$lib/types/rules';

const state = vi.hoisted(() => ({
	emails: [] as Record<string, unknown>[],
	cursor: null as string | null,
	setCursors: [] as string[],
	rules: [] as unknown[],
	sets: [] as Record<string, unknown>[],
	gate: null as Promise<void> | null,
	queried: () => {},
	tasks: [] as string[],
	tasksFail: false
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
				const listed = state.emails;
				state.queried();
				if (state.gate) await state.gate;
				return {
					methodResponses: [
						['Email/query', { ids: listed.map((e) => e.id) }, 'q'],
						['Email/get', { list: listed }, 'g']
					],
					sessionState: ''
				};
			}
			if (name === 'Email/set') {
				state.sets.push(calls[0][1].update as Record<string, unknown>);
				return { methodResponses: [['Email/set', { updated: {} }, '0']], sessionState: '' };
			}
			throw new Error(`unexpected ${name}`);
		}
	})
}));
vi.mock('./account-tasks', () => ({
	runAccountTasks: async (_auth: unknown, email: string) => {
		state.tasks.push(email);
		if (state.tasksFail) throw new Error('tasks broke');
	}
}));
vi.mock('./auth/accounts', () => ({ listSchedulableAuths: () => [], markNeedsReauth: vi.fn() }));
vi.mock('./db/queries/rules', () => ({
	getRules: () => state.rules,
	getRulesCursor: () => state.cursor,
	setRulesCursor: (_user: string, iso: string) => state.setCursors.push(iso)
}));

import type { AuthState } from '$lib/jmap/types';
import { applyRulesForUser, applyRulesNow } from './rules-scheduler';

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
	state.sets = [];
	state.gate = null;
	state.queried = () => {};
	state.tasks = [];
	state.tasksFail = false;
});

describe('the auto-apply cursor', () => {
	it('steps back a second behind a full page, so the rest of the last second is read next time', async () => {
		state.emails = page(100, (i) => (i < 99 ? '2026-10-20T07:00:00Z' : '2026-10-20T07:00:05Z'));
		await applyRulesForUser(auth, 'me@example.test');
		expect(state.setCursors).toEqual(['2026-10-20T07:00:04.000Z']);
	});

	it('moves on when a whole page shares one second, instead of re-reading it forever', async () => {
		state.cursor = '2026-10-20T07:00:00.000Z';
		state.emails = page(100, () => '2026-10-20T07:00:00Z');
		await applyRulesForUser(auth, 'me@example.test');
		expect(state.setCursors).toEqual(['2026-10-20T07:00:00Z']);
	});

	it('jumps to the second before now after a partial page', async () => {
		state.emails = page(3, () => '2026-10-20T07:00:00Z');
		const before = Date.now();
		await applyRulesForUser(auth, 'me@example.test');
		// Mail landing later in this run's second, after its query, is read next time.
		expect(Date.parse(state.setCursors[0])).toBe(Math.floor(before / 1000) * 1000 - 1000);
	});

	it('reads its own second again without acting twice on what it already handled', async () => {
		const user = 'twice@example.test';
		state.emails = page(2, () => '2026-10-20T07:00:00Z');
		await applyRulesForUser(auth, user);
		expect(state.sets).toHaveLength(1);

		// The second message of that second landed after the first run's query.
		state.emails = [...page(2, () => '2026-10-20T07:00:00Z'), ...page(3, () => '2026-10-20T07:00:00Z').slice(2)];
		await applyRulesForUser(auth, user);
		expect(Object.keys(state.sets[1])).toEqual(['m2']);
	});
});

describe('rules that may not run', () => {
	it('are passed over, even switched on: a rule waiting to be rewritten, and one with a condition Jev judged', async () => {
		state.emails = page(2, () => '2026-10-20T07:00:00Z');
		// Flagged by the upgrade, then switched back on without being fixed.
		const flagged = { ...markRead, attention: 'jev_condition', enabled: true };
		// As an old browser tab would save it, the Jev condition still there.
		const unconverted = {
			...markRead,
			id: 'r2',
			conditions: [...markRead.conditions, { id: 'j1', field: 'jev', op: 'contains', value: 'an invoice', negate: false }]
		};
		state.rules = [flagged, unconverted];
		await applyRulesForUser(auth, 'flagged@example.test');
		expect(state.sets).toEqual([]);

		// The same mail, once the rule is an ordinary one again.
		state.rules = [markRead];
		await applyRulesForUser(auth, 'flagged@example.test');
		expect(state.sets.map((u) => Object.keys(u))).toEqual([['m0', 'm1']]);
	});
});

describe('the account’s one-time tasks', () => {
	it('run on every run, rules or none, and never hold the rules up', async () => {
		state.rules = [];
		await applyRulesForUser(auth, 'tasks@example.test');
		expect(state.tasks).toEqual(['tasks@example.test']);

		state.rules = [markRead];
		state.tasksFail = true;
		state.emails = page(1, () => '2026-10-20T07:00:00Z');
		await applyRulesForUser(auth, 'tasks@example.test');
		expect(state.tasks).toHaveLength(2);
		expect(state.sets.map((u) => Object.keys(u))).toEqual([['m0']]);
	});
});

describe('applyRulesNow', () => {
	it('waits out a run already going, then runs again for mail it may have missed', async () => {
		const user = 'now@example.test';
		let release!: () => void;
		state.gate = new Promise<void>((resolve) => (release = resolve));
		state.emails = page(1, () => '2026-10-20T07:00:00Z');
		const queried = new Promise<void>((resolve) => (state.queried = resolve));
		const first = applyRulesForUser(auth, user);
		await queried;

		// Mail lands just after the first run read the Inbox.
		state.emails = page(2, () => '2026-10-20T07:00:00Z');
		const now = applyRulesNow(auth, user);
		release();
		state.gate = null;
		await first;
		await now;

		expect(state.sets.map((u) => Object.keys(u))).toEqual([['m0'], ['m1']]);
	});
});
