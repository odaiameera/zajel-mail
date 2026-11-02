import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Rule, RuleAction, RuleCondition } from '$lib/types/rules';

// A small Inbox: Email/query pages it by position, and an Email/set that
// takes a message out of the Inbox removes it from the listing, as the
// server would.
const state = vi.hoisted(() => ({
	emails: [] as Record<string, unknown>[],
	queries: [] as Record<string, unknown>[],
	sets: [] as Record<string, Record<string, unknown>>[],
	mailboxes: [
		{ id: 'IN', name: 'Inbox', role: 'inbox', parentId: null, totalEmails: 0 },
		{ id: 'ARCH', name: 'Archive', role: 'archive', parentId: null, totalEmails: 0 },
		{ id: 'TRASH', name: 'Trash', role: 'trash', parentId: null, totalEmails: 0 }
	]
}));

vi.mock('$lib/jmap/auth', () => ({
	createClient: () => ({
		request: async (calls: [string, Record<string, unknown>, string][]) => {
			const [name, args] = calls[0];
			if (name === 'Mailbox/get') {
				return { methodResponses: [['Mailbox/get', { list: state.mailboxes }, '0']], sessionState: '' };
			}
			if (name === 'Email/get') {
				const ids = args.ids as string[];
				return {
					methodResponses: [['Email/get', { list: state.emails.filter((e) => ids.includes(e.id as string)) }, 'g']],
					sessionState: ''
				};
			}
			if (name === 'Email/query') {
				state.queries.push(args);
				const position = (args.position as number) ?? 0;
				const page = state.emails.slice(position, position + (args.limit as number));
				return {
					methodResponses: [
						['Email/query', { ids: page.map((e) => e.id) }, 'q'],
						['Email/get', { list: page }, 'g']
					],
					sessionState: ''
				};
			}
			if (name === 'Email/set') {
				const update = args.update as Record<string, Record<string, unknown>>;
				state.sets.push(update);
				for (const [id, patch] of Object.entries(update)) {
					const boxes = patch.mailboxIds as Record<string, boolean> | undefined;
					if (boxes && !boxes.IN) state.emails = state.emails.filter((e) => e.id !== id);
				}
				return {
					methodResponses: [['Email/set', { updated: Object.fromEntries(Object.keys(update).map((id) => [id, null])) }, '0']],
					sessionState: ''
				};
			}
			throw new Error(`unexpected ${name}`);
		}
	})
}));

import { POST } from './+server';

async function apply(body: Record<string, unknown>) {
	const res = await POST({
		request: new Request('http://localhost/api/rules/apply', { method: 'POST', body: JSON.stringify(body) }),
		locals: { auth: { accountId: 'jmap' } }
	} as unknown as Parameters<typeof POST>[0]);
	const text = await res.text();
	return text
		.split('\n\n')
		.filter(Boolean)
		.map((line) => JSON.parse(line.replace(/^data: /, '')) as Record<string, unknown>);
}

const email = (id: string, subject: string) => ({
	id,
	subject,
	from: [{ name: 'Alice', email: 'alice@example.test' }],
	to: [],
	mailboxIds: { IN: true },
	keywords: {},
	size: 10,
	hasAttachment: false,
	receivedAt: '2026-10-20T07:00:00Z',
	preview: ''
});

const rule = (conditions: RuleCondition[], actions: RuleAction[]): Rule => ({
	id: 'r1',
	name: 'Hello',
	enabled: true,
	logic: 'allof',
	conditions,
	actions,
	createdAt: 0
});

const subject = (op: RuleCondition['op'], value: string, negate = false): RuleCondition => ({
	id: 'c1',
	field: 'subject',
	op,
	value,
	negate
});

beforeEach(() => {
	state.emails = [];
	state.queries = [];
	state.sets = [];
});

describe('apply now', () => {
	it('judges each Inbox message with the engine, so NOT plus "doesn\'t contain" is a double negative', async () => {
		state.emails = [email('m1', 'hello world'), email('m2', 'other')];
		const events = await apply({
			rules: [rule([subject('not_contains', 'hello', true)], [{ type: 'markRead' }])]
		});

		expect(state.queries[0].filter).toEqual({ inMailbox: 'IN' });
		expect(state.sets).toEqual([{ m1: { 'keywords/$seen': true } }]);
		expect(events.at(-1)).toMatchObject({ type: 'done', scanned: 2, matched: 1, applied: 1, failed: 0 });
	});

	it('matches "is" exactly, not as contains', async () => {
		state.emails = [email('m1', 'hello'), email('m2', 'hello world')];
		const events = await apply({ rules: [rule([subject('is', 'hello')], [{ type: 'markImportant' }])] });
		expect(state.sets).toEqual([{ m1: { 'keywords/$flagged': true } }]);
		expect(events.at(-1)).toMatchObject({ matched: 1 });
	});

	it('keeps paging from the right place when a move takes messages out of the Inbox', async () => {
		// One more than a page, every one of them moved: the second page must
		// start where the listing now starts, or the last message is skipped.
		state.emails = Array.from({ length: 201 }, (_, i) => email(`m${i}`, 'move me'));
		const events = await apply({
			rules: [rule([subject('contains', 'move')], [{ type: 'moveToFolder', value: 'ARCH' }])]
		});
		expect(state.queries.map((q) => q.position)).toEqual([0, 0]);
		expect(events.at(-1)).toMatchObject({ type: 'done', scanned: 201, matched: 201, applied: 201 });
		expect(state.emails).toEqual([]);
	});
});

describe('applying a Jev rule to the emails the editor chose', () => {
	const jev = (value: string): RuleCondition => ({ id: 'j1', field: 'jev', op: 'contains', value, negate: false });

	it('never moves mail to Trash, whatever the rule says, and still does the rest', async () => {
		state.emails = [email('m1', 'invoice')];
		const events = await apply({
			rules: [rule([jev('it is an invoice')], [{ type: 'moveToFolder', value: 'TRASH' }, { type: 'markRead' }])],
			ids: ['m1']
		});
		expect(state.sets).toEqual([{ m1: { 'keywords/$seen': true } }]);
		expect(events.at(-1)).toMatchObject({ type: 'done', applied: 1, failed: 0 });
	});

	it('moves to an ordinary folder as asked', async () => {
		state.emails = [email('m1', 'invoice')];
		await apply({ rules: [rule([jev('it is an invoice')], [{ type: 'moveToFolder', value: 'ARCH' }])], ids: ['m1'] });
		expect(state.sets).toEqual([{ m1: { mailboxIds: { ARCH: true } } }]);
	});
});
