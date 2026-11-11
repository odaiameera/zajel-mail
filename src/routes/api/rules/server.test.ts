import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Rule, RuleCondition, RuleDraft } from '$lib/types/rules';

// A small Inbox: Email/query pages it by position, newest first as stored,
// and an Email/set that takes a message out of the Inbox removes it from
// the listing, as the server would. `gate` holds back a chosen query.
const state = vi.hoisted(() => ({
	emails: [] as Record<string, unknown>[],
	queries: [] as Record<string, unknown>[],
	gets: [] as Record<string, unknown>[],
	sets: [] as Record<string, Record<string, unknown>>[],
	saved: [] as unknown[],
	gate: null as { at: number; wait: Promise<void> } | null,
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
				const list = state.mailboxes.map((m) => (m.role === 'inbox' ? { ...m, totalEmails: state.emails.length } : m));
				return { methodResponses: [['Mailbox/get', { list }, '0']], sessionState: '' };
			}
			if (name === 'Email/query') {
				state.queries.push(args);
				state.gets.push(calls[1][1]);
				if (state.gate && state.queries.length === state.gate.at) await state.gate.wait;
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
vi.mock('$lib/server/rules/store', () => ({ listRules: () => state.saved }));

import { POST as applyPOST } from './apply/+server';
import { POST as previewPOST } from './preview/+server';

const locals = { auth: { accountId: 'jmap' }, activeAccountId: 'acct' };

async function apply(body: Record<string, unknown>) {
	const res = await applyPOST({
		request: new Request('http://localhost/api/rules/apply', { method: 'POST', body: JSON.stringify(body) }),
		locals
	} as unknown as Parameters<typeof applyPOST>[0]);
	return events(await res.text());
}

const events = (text: string) =>
	text
		.split('\n\n')
		.filter(Boolean)
		.map((line) => JSON.parse(line.replace(/^data: /, '')) as Record<string, unknown>);

async function preview(rule: unknown): Promise<Record<string, unknown>> {
	const res = await previewPOST({
		request: new Request('http://localhost/api/rules/preview', { method: 'POST', body: JSON.stringify({ rule }) }),
		locals
	} as unknown as Parameters<typeof previewPOST>[0]);
	return res.json();
}

const email = (id: string, subject: string, body = '') => ({
	id,
	subject,
	from: [{ name: 'Alice', email: 'alice@example.test' }],
	to: [],
	mailboxIds: { IN: true },
	keywords: {},
	size: 10,
	hasAttachment: false,
	receivedAt: '2026-10-20T07:00:00Z',
	preview: '',
	textBody: [{ partId: '1' }],
	bodyValues: { '1': { value: body } }
});

const rule = (conditions: RuleCondition[], does: Partial<RuleDraft>, id = 'r1'): Rule => ({
	id,
	name: 'Hello',
	enabled: true,
	logic: 'allof',
	conditions,
	target: { kind: 'none' },
	markRead: false,
	star: false,
	stop: false,
	position: 0,
	createdAt: 0,
	updatedAt: 0,
	...does
});

const cond = (field: RuleCondition['field'], op: RuleCondition['op'], value: string, negate = false): RuleCondition => ({
	id: 'c1',
	field,
	op,
	value,
	negate
});
const subject = (op: RuleCondition['op'], value: string, negate = false) => cond('subject', op, value, negate);

const moveToArchive: Partial<RuleDraft> = { target: { kind: 'archive' } };

beforeEach(() => {
	state.emails = [];
	state.queries = [];
	state.gets = [];
	state.sets = [];
	state.saved = [];
	state.gate = null;
});

describe('preview and apply agree', () => {
	// Mail the server's word search would have miscounted: "hello" is a word
	// of every subject here, yet "is", "starts with" and NOT each want only some.
	const inbox = () => [
		email('m1', 'hello', 'the invoice is attached'),
		email('m2', 'hello world', 'nothing here'),
		email('m3', 'say hello', 'INVOICE enclosed'),
		email('m4', 'other', 'no')
	];
	const cases: [string, RuleCondition, string[]][] = [
		['is', subject('is', 'hello'), ['m1']],
		['starts with', subject('starts_with', 'hello'), ['m1', 'm2']],
		['ends with', subject('ends_with', 'hello'), ['m1', 'm3']],
		['NOT contains', subject('contains', 'hello', true), ['m4']],
		['a body condition', cond('body', 'contains', 'invoice'), ['m1', 'm3']]
	];

	for (const [what, c, moved] of cases) {
		it(`for ${what}`, async () => {
			const r = rule([c], moveToArchive);
			state.emails = inbox();
			const counted = await preview(r);
			expect(state.sets).toEqual([]);

			state.saved = [r];
			const done = (await apply({ ruleIds: ['r1'] })).at(-1);
			const movedIds = state.sets.flatMap((s) => Object.keys(s));

			expect(counted).toEqual({ matched: moved.length, scanned: 4, total: 4 });
			expect(done).toMatchObject({ type: 'done', scanned: 4, matched: moved.length, applied: moved.length });
			expect(movedIds.sort()).toEqual(moved);
		});
	}
});

describe('the preview', () => {
	it('never writes, and looks at the newest Inbox messages only', async () => {
		state.emails = Array.from({ length: 700 }, (_, i) => email(`m${i}`, 'hello'));
		const counted = await preview(rule([subject('contains', 'hello')], moveToArchive));
		expect(counted).toEqual({ matched: 500, scanned: 500, total: 700 });
		expect(state.sets).toEqual([]);
		expect(state.queries.map((q) => q.filter)).toEqual([{ inMailbox: 'IN' }, { inMailbox: 'IN' }, { inMailbox: 'IN' }]);
		expect(state.queries[0].sort).toEqual([{ property: 'receivedAt', isAscending: false }]);
		expect(state.queries.map((q) => q.limit)).toEqual([200, 200, 100]);
	});

	it('looks at fewer messages when it has to read their bodies', async () => {
		state.emails = Array.from({ length: 700 }, (_, i) => email(`m${i}`, 'x', 'invoice'));
		expect(await preview(rule([cond('body', 'contains', 'invoice')], moveToArchive))).toEqual({
			matched: 200,
			scanned: 200,
			total: 700
		});
		expect(state.gets[0].fetchTextBodyValues).toBe(true);
	});

	it('counts a rule being drafted switched off as it would run', async () => {
		state.emails = [email('m1', 'hello')];
		expect(await preview({ ...rule([subject('is', 'hello')], moveToArchive), enabled: false })).toMatchObject({ matched: 1 });
	});

	it('takes the draft through parseRule: conditions that don’t hold up count nothing, and say why', async () => {
		state.emails = [email('m1', 'hello')];
		const r = rule([subject('contains', 'hello')], moveToArchive);
		const jev = { id: 'j', field: 'jev', op: 'contains', value: 'it is an invoice', negate: false };
		expect(await preview({ ...r, conditions: [subject('contains', 'hello'), jev] })).toEqual({
			matched: 0,
			scanned: 0,
			total: 0,
			problems: [{ field: 'conditions', index: 1, message: 'Pick what this condition looks at.' }]
		});
		expect(state.queries).toEqual([]);

		// The control: the same rule, with exact conditions only, is counted.
		expect(await preview(r)).toEqual({ matched: 1, scanned: 1, total: 1 });
	});

	it('counts a draft with nowhere to file yet, and says what it still needs', async () => {
		state.emails = [email('m1', 'hello')];
		expect(await preview(rule([subject('is', 'hello')], {}))).toEqual({
			matched: 1,
			scanned: 1,
			total: 1,
			problems: [{ field: 'actions', message: 'Give the rule something to do: a place to file mail, mark as read, or star.' }]
		});
	});
});

describe('apply now', () => {
	it('acts on the saved rules, never on rules in the request', async () => {
		state.emails = [email('m1', 'hello'), email('m2', 'other')];
		state.saved = [rule([subject('is', 'other')], { markRead: true })];
		const done = (await apply({ rules: [rule([subject('is', 'hello')], moveToArchive)] })).at(-1);
		expect(state.sets).toEqual([{ m2: { 'keywords/$seen': true } }]);
		expect(done).toMatchObject({ type: 'done', matched: 1, applied: 1 });
	});

	it('runs only the chosen saved rules, and refuses ids it doesn’t have', async () => {
		state.emails = [email('m1', 'hello'), email('m2', 'other')];
		state.saved = [rule([subject('is', 'hello')], { markRead: true }, 'a'), rule([subject('is', 'other')], { star: true }, 'b')];
		await apply({ ruleIds: ['b'] });
		expect(state.sets).toEqual([{ m2: { 'keywords/$flagged': true } }]);

		state.sets = [];
		const res = await applyPOST({
			request: new Request('http://localhost/api/rules/apply', { method: 'POST', body: JSON.stringify({ ruleIds: ['b', 'nope'] }) }),
			locals
		} as unknown as Parameters<typeof applyPOST>[0]);
		expect(res.status).toBe(400);
		expect(state.queries).toHaveLength(1);
		expect(state.sets).toEqual([]);
	});

	it('judges each Inbox message with the engine, so NOT plus "doesn\'t contain" is a double negative', async () => {
		state.emails = [email('m1', 'hello world'), email('m2', 'other')];
		state.saved = [rule([subject('not_contains', 'hello', true)], { markRead: true })];
		const events = await apply({});
		expect(state.queries[0].filter).toEqual({ inMailbox: 'IN' });
		expect(state.sets).toEqual([{ m1: { 'keywords/$seen': true } }]);
		expect(events.at(-1)).toMatchObject({ type: 'done', scanned: 2, matched: 1, applied: 1, failed: 0 });
	});

	it('keeps paging from the right place when a move takes messages out of the Inbox', async () => {
		// One more than a page, every one of them moved: the second page must
		// start where the listing now starts, or the last message is skipped.
		state.emails = Array.from({ length: 201 }, (_, i) => email(`m${i}`, 'move me'));
		state.saved = [rule([subject('contains', 'move')], moveToArchive)];
		const events = await apply({});
		expect(state.queries.map((q) => q.position)).toEqual([0, 0]);
		expect(events.at(-1)).toMatchObject({ type: 'done', scanned: 201, matched: 201, applied: 201 });
		expect(state.emails).toEqual([]);
	});

	it('stops at the next page when cancelled', async () => {
		state.emails = Array.from({ length: 450 }, (_, i) => email(`m${i}`, 'hello'));
		state.saved = [rule([subject('contains', 'hello')], { markRead: true })];
		let release = () => {};
		state.gate = { at: 2, wait: new Promise<void>((r) => (release = r)) };

		const res = await applyPOST({
			request: new Request('http://localhost/api/rules/apply', { method: 'POST', body: '{}' }),
			locals
		} as unknown as Parameters<typeof applyPOST>[0]);
		const reader = res.body!.getReader();
		const decoder = new TextDecoder();
		let seen = '';
		while (!seen.includes('"progress"')) seen += decoder.decode((await reader.read()).value);
		await reader.cancel();
		release();
		await vi.waitFor(() => expect(state.sets).toHaveLength(Math.ceil(400 / 50)));
		await new Promise((r) => setTimeout(r, 20));

		// The page in flight when Cancel came finishes; the third is never read.
		expect(state.queries).toHaveLength(2);
	});

	it('reports the preflight for a rule whose target is gone', async () => {
		state.emails = [email('m1', 'hello')];
		state.saved = [rule([subject('contains', 'hello')], { target: { kind: 'folder', mailboxId: 'GONE' } })];
		const events = await apply({});
		expect(events.at(-1)).toMatchObject({ type: 'error' });
		expect(state.sets).toEqual([]);
	});
});

describe('rules that may not run', () => {
	it('never act through "apply now", even switched on', async () => {
		state.emails = [email('m1', 'hello world')];
		// Flagged by the upgrade (its Jev condition gone, the exact part left),
		// then saved as an enabled rule.
		const flagged = { ...rule([subject('contains', 'hello')], moveToArchive), attention: 'jev_condition' };
		state.saved = [flagged];
		const events = await apply({ ruleIds: ['r1'] });
		expect(state.sets).toEqual([]);
		expect(events.at(-1)).toMatchObject({ type: 'done', matched: 0, applied: 0 });

		// And one stored before the upgrade, with the Jev condition in it.
		const jev = { id: 'j1', field: 'jev', op: 'contains', value: 'it is an invoice', negate: false } as unknown as RuleCondition;
		state.saved = [rule([subject('contains', 'hello'), jev], moveToArchive)];
		await apply({});
		expect(state.sets).toEqual([]);

		// The control: the same rule without the flag does move the message.
		state.saved = [{ ...flagged, attention: undefined }];
		await apply({});
		expect(state.sets).toEqual([{ m1: { mailboxIds: { ARCH: true } } }]);
	});
});
