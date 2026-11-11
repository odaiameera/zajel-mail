// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';

vi.mock('$app/navigation', () => ({ invalidateAll: vi.fn() }));

import type { Mailbox } from '$lib/jmap/types';
import { needsRewrite, type Rule, type RuleCondition } from '$lib/types/rules';
import Page from './+page.svelte';

beforeEach(() => {
	// jsdom has no Web Animations API, and the page's transitions need one
	// whose animations finish.
	(HTMLElement.prototype as unknown as { animate: unknown }).animate = () => {
		const animation = { cancel() {}, onfinish: null as (() => void) | null };
		queueMicrotask(() => animation.onfinish?.());
		return animation;
	};
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate;
});

const cond = (id: string, field: RuleCondition['field'], value: string): RuleCondition => ({
	id,
	field,
	op: 'contains',
	value,
	negate: false
});

const base = (id: string, name: string, over: Partial<Rule> = {}): Rule => ({
	id,
	name,
	enabled: true,
	logic: 'allof',
	conditions: [cond(`c-${id}`, 'from', 'shop.example')],
	target: { kind: 'none' },
	markRead: true,
	star: false,
	stop: false,
	position: 0,
	createdAt: 1,
	updatedAt: 1,
	...over
});

const exact = base('exact', 'Receipts', { target: { kind: 'folder', mailboxId: 'RCPT' }, markRead: false });

// As the upgrade leaves a rule that had a condition Jev judged.
const flagged = base('flagged', 'Invoices', {
	enabled: false,
	conditions: [cond('c2', 'from', 'billing@')],
	attention: 'jev_condition',
	legacy: {
		enabled: true,
		logic: 'allof',
		conditions: [
			cond('c2', 'from', 'billing@'),
			{ id: 'j1', field: 'jev', op: 'contains', value: 'it’s an invoice or a request for payment', negate: false, strictness: 'strict' }
		] as never,
		actions: [{ type: 'markRead' }]
	}
});

// A rule that only put mail in a tab, and wasn't a plain match on one sender.
const tabOnly = base('tab-only', 'Digests to Updates', {
	enabled: false,
	markRead: false,
	conditions: [cond('c3', 'subject', 'digest')],
	attention: 'tab_rule',
	legacy: {
		enabled: true,
		logic: 'allof',
		conditions: [cond('c3', 'subject', 'digest')] as never,
		actions: [{ type: 'setCategory', value: 'updates' }]
	},
	note: { tab: { tab: 'updates', why: 'not_one_sender' } }
});

// A rule that only put one sender's mail in a tab: it became that sender's pin.
const becamePin = base('became-pin', 'Amazon to Promotions', {
	enabled: false,
	markRead: false,
	conditions: [cond('c5', 'from', '@amazon.co')],
	attention: 'tab_pinned',
	legacy: {
		enabled: true,
		logic: 'allof',
		conditions: [cond('c5', 'from', '@amazon.co')] as never,
		actions: [{ type: 'setCategory', value: 'promotions' }]
	},
	note: { tab: { tab: 'promotions', pin: { sender: '@amazon.co', category: 'promotions' }, op: 'contains', said: '@amazon.co' } }
});

// A tab rule for a sender that was already pinned to another tab: the pin was kept.
const pinnedElsewhere = base('pinned-elsewhere', 'Shop news to Updates', {
	enabled: false,
	markRead: false,
	conditions: [cond('c6', 'from', 'news@shop.example')],
	attention: 'tab_rule',
	note: {
		tab: {
			tab: 'updates',
			pin: { sender: 'news@shop.example', category: 'updates' },
			op: 'contains',
			said: 'news@shop.example',
			why: 'pinned_elsewhere',
			kept: { sender: 'news@shop.example', category: 'promotions' }
		}
	}
});

// A rule that labelled mail and put it in a tab: the label part still runs.
const tabRemoved = base('tab-removed', 'Work mail', {
	conditions: [cond('c4', 'from', '@work.example')],
	attention: 'tab_removed',
	legacy: {
		enabled: true,
		logic: 'allof',
		conditions: [cond('c4', 'from', '@work.example')] as never,
		actions: [{ type: 'markRead' }, { type: 'setCategory', value: 'newsletters' }]
	}
});

// The second of the rules a rule that filed into two places became.
const splitRow = base('split~2', 'Shop', { target: { kind: 'label', mailboxId: 'WORK' }, markRead: false, attention: 'split', note: { splitInto: 2 } });

const mailboxes = [
	{ id: 'IN', name: 'Inbox', role: 'inbox', parentId: null },
	{ id: 'TR', name: 'Trash', role: 'trash', parentId: null },
	{ id: 'RCPT', name: 'Receipts', role: null, parentId: null },
	{ id: 'LBLS', name: 'Labels', role: null, parentId: null },
	{ id: 'WORK', name: 'Work', role: null, parentId: 'LBLS' }
] as unknown as Mailbox[];
const labels = [{ id: 'WORK', name: 'Work', color: '#000' }];

/** A small rules API: the page's requests, answered from `server.rules`, and recorded. */
const server = {
	rules: [] as Rule[],
	calls: [] as { method: string; url: string; body: unknown }[],
	problems: null as unknown[] | null,
	pinsWork: true,
	preview: { matched: 3, scanned: 3, total: 3 } as Record<string, number>
};
const writes = () => server.calls.filter((c) => c.method !== 'GET' && !c.url.endsWith('/preview'));
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

function stubFetch(rules: Rule[]) {
	server.rules = structuredClone(rules);
	server.calls = [];
	server.problems = null;
	server.pinsWork = true;
	server.preview = { matched: 3, scanned: 3, total: 3 };
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string, init?: RequestInit) => {
			const method = init?.method ?? 'GET';
			const body = init?.body ? JSON.parse(String(init.body)) : undefined;
			server.calls.push({ method, url, body });
			const [, id, verb] = url.match(/^\/api\/rules\/([^/]+)(?:\/(\w+))?$/) ?? [];
			const find = () => server.rules.find((r) => r.id === decodeURIComponent(id));
			if (url === '/api/rules' && method === 'GET') return ok({ rules: server.rules });
			if (url === '/api/rules/preview') return ok(server.preview);
			if (url === '/api/rules/apply') return new Response('data: {"type":"done","scanned":1,"matched":1,"applied":1,"failed":0}\n\n');
			if (url === '/api/rules/reorder') {
				server.rules = body.ids.map((i: string) => server.rules.find((r) => r.id === i));
				return ok({ rules: server.rules });
			}
			if ((url === '/api/rules' || method === 'PATCH') && server.problems) {
				return new Response(JSON.stringify({ error: 'no', problems: server.problems }), { status: 400 });
			}
			if (url === '/api/rules') {
				const rule = { ...base('new-1', ''), ...body };
				server.rules.push(rule);
				return ok({ rule });
			}
			if (method === 'PATCH') {
				const { rewrite, ...edit } = body;
				const rule = { ...find()!, ...edit };
				// As the server does it: only a rewrite switches a flagged rule back on.
				if (rewrite === true) {
					rule.enabled = true;
					delete rule.attention;
					delete rule.legacy;
				} else if (needsRewrite(find()!)) rule.enabled = false;
				server.rules = server.rules.map((r) => (r.id === rule.id ? rule : r));
				return ok({ rule });
			}
			if (method === 'DELETE') {
				server.rules = server.rules.filter((r) => r.id !== find()!.id);
				return ok({ success: true });
			}
			if (verb === 'dismiss') {
				const rule = find()!;
				if (rule.attention === 'tab_pinned') server.rules = server.rules.filter((r) => r !== rule);
				else {
					delete rule.attention;
					delete rule.note;
				}
				return ok({ success: true });
			}
			if (verb === 'pin') {
				if (!server.pinsWork) return new Response(JSON.stringify({ error: 'Unknown account' }), { status: 404 });
				server.rules = server.rules.filter((r) => r !== find());
				return ok({ success: true });
			}
			throw new Error(`unexpected ${method} ${url}`);
		})
	);
}

const page = (rules: Rule[]) => {
	stubFetch(rules);
	return render(Page, { props: { data: { rules: structuredClone(rules), labels, mailboxes } } as never });
};
const attentionList = () => screen.getByRole('heading', { name: 'Needs your attention' }).nextElementSibling as HTMLElement;

describe('Settings → Rules', () => {
	it('lists each rule as conditions → target, saying when the target is missing', () => {
		page([exact, base('gone', 'Gone', { target: { kind: 'folder', mailboxId: 'DELETED' } }), splitRow]);
		expect(screen.getByText('From contains “shop.example” → Receipts')).toBeTruthy();
		expect(screen.getByText('From contains “shop.example” → target missing')).toBeTruthy();
		expect(screen.getByText('From contains “shop.example” → Work')).toBeTruthy();
	});

	it('sends nothing while a rule is edited, until Save', async () => {
		page([exact]);
		await fireEvent.input(screen.getByLabelText('Name'), { target: { value: 'Renamed' } });
		await fireEvent.click(screen.getByLabelText('Star'));
		expect(writes()).toEqual([]);

		await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		await waitFor(() => expect(writes()).toHaveLength(1));
		expect(writes()[0]).toMatchObject({ method: 'PATCH', url: '/api/rules/exact', body: { name: 'Renamed', star: true } });
		await waitFor(() => expect(screen.getByText('Renamed')).toBeTruthy());
	});

	it('creates a new rule only on Save, with one place to file it', async () => {
		page([]);
		await fireEvent.click(screen.getByRole('button', { name: '+ New rule' }));
		await fireEvent.input(screen.getByLabelText('Name'), { target: { value: 'Shop' } });
		await fireEvent.input(screen.getByLabelText('Value'), { target: { value: 'shop.example' } });
		await fireEvent.change(screen.getByLabelText('File it in'), { target: { value: 'label:WORK' } });
		expect(writes()).toEqual([]);
		await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		await waitFor(() => expect(writes()).toHaveLength(1));
		expect(writes()[0]).toMatchObject({
			method: 'POST',
			url: '/api/rules',
			body: { name: 'Shop', target: { kind: 'label', mailboxId: 'WORK' }, markRead: false, star: false, stop: false }
		});
	});

	it('shows what the server found wrong beside the field it is about', async () => {
		page([exact]);
		server.problems = [
			{ field: 'name', message: 'Give the rule a name.' },
			{ field: 'conditions', index: 0, message: 'Keep this to 500 characters or fewer.' },
			{ field: 'target', message: 'Pick a folder: the one chosen no longer exists.' }
		];
		await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		await waitFor(() => expect(screen.getByText('Give the rule a name.')).toBeTruthy());
		expect(screen.getByText('Keep this to 500 characters or fewer.')).toBeTruthy();
		expect(screen.getByText('Pick a folder: the one chosen no longer exists.')).toBeTruthy();
	});

	it('moves a rule up and down through reorder', async () => {
		const [a, b, c] = ['a', 'b', 'c'].map((id) => base(id, id.toUpperCase()));
		page([a, b, c]);
		const rows = () => [...document.querySelectorAll('aside li')].map((li) => li.querySelector('.text-sm')?.textContent);
		const row = (name: string) => within(screen.getByText(name).closest('li') as HTMLElement);

		await fireEvent.click(row('C').getByRole('button', { name: 'Move up' }));
		await waitFor(() => expect(rows()).toEqual(['A', 'C', 'B']));
		expect(writes()).toEqual([{ method: 'POST', url: '/api/rules/reorder', body: { ids: ['a', 'c', 'b'] } }]);

		await fireEvent.click(row('A').getByRole('button', { name: 'Move down' }));
		await waitFor(() => expect(rows()).toEqual(['C', 'A', 'B']));
		expect((row('C').getByRole('button', { name: 'Move up' }) as HTMLButtonElement).disabled).toBe(true);
		expect((row('B').getByRole('button', { name: 'Move down' }) as HTMLButtonElement).disabled).toBe(true);
	});

	it('moves a rule past the next rule that runs, a split rule’s second half included', async () => {
		const a = base('a', 'A', { target: { kind: 'label', mailboxId: 'WORK' } });
		const a2 = base('a~2', 'A too', { target: { kind: 'folder', mailboxId: 'RCPT' }, stop: true, attention: 'split', note: { splitInto: 2 } });
		page([a, a2, base('b', 'B')]);
		await fireEvent.click(within(screen.getByText('B').closest('li') as HTMLElement).getByRole('button', { name: 'Move up' }));
		await waitFor(() => expect(writes()).toHaveLength(1));
		expect(writes()[0].body).toEqual({ ids: ['a', 'b', 'a~2'] });
	});

	it('moves past a rule waiting under "Needs your attention", leaving it where it is', async () => {
		const f = { ...flagged, id: 'f' };
		page([base('a', 'A'), f, base('b', 'B')]);
		expect(within(attentionList()).queryByRole('button', { name: /Move/ })).toBeNull();
		const row = (name: string) => within(screen.getByText(name).closest('li') as HTMLElement);
		expect((row('A').getByRole('button', { name: 'Move up' }) as HTMLButtonElement).disabled).toBe(true);
		await fireEvent.click(row('B').getByRole('button', { name: 'Move up' }));
		await waitFor(() => expect(writes()).toHaveLength(1));
		expect(writes()[0].body).toEqual({ ids: ['b', 'f', 'a'] });
	});

	it('lists a split rule and one that lost its tab where they run, each with its note and "Got it"', async () => {
		page([exact, splitRow, base('c', 'C'), tabRemoved]);
		expect(screen.queryByRole('heading', { name: 'Needs your attention' })).toBeNull();
		const rows = () => [...document.querySelectorAll('aside li')].map((li) => li.querySelector('.text-sm')?.textContent);
		expect(rows()).toEqual(['Receipts', 'Shop', 'C', 'Work mail']);
		const row = (name: string) => within(screen.getByText(name).closest('li') as HTMLElement);
		expect(row('Shop').getByText('One of 2 rules a rule filing in several places became.')).toBeTruthy();
		expect(row('Work mail').getByText('No longer puts mail in the Newsletters tab.')).toBeTruthy();
		await fireEvent.click(row('Shop').getByRole('button', { name: 'Got it' }));
		await waitFor(() => expect(writes()).toEqual([{ method: 'POST', url: '/api/rules/split~2/dismiss', body: undefined }]));
		await waitFor(() => expect(row('Shop').queryByRole('button', { name: 'Got it' })).toBeNull());
		expect(rows()).toEqual(['Receipts', 'Shop', 'C', 'Work mail']);
	});

	it('disables moving while a change is being saved', async () => {
		page([base('a', 'A'), base('b', 'B'), base('c', 'C')]);
		let release!: () => void;
		const realFetch = globalThis.fetch;
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string, init?: RequestInit) => {
				if (url === '/api/rules/reorder') await new Promise<void>((r) => (release = r));
				return realFetch(url, init);
			})
		);
		const row = (name: string) => within(screen.getByText(name).closest('li') as HTMLElement);
		await fireEvent.click(row('B').getByRole('button', { name: 'Move up' }));
		await waitFor(() => expect((row('C').getByRole('button', { name: 'Move up' }) as HTMLButtonElement).disabled).toBe(true));
		release();
		await waitFor(() => expect((row('C').getByRole('button', { name: 'Move up' }) as HTMLButtonElement).disabled).toBe(false));
	});

	it('saves, then applies the saved rule by its id', async () => {
		page([exact]);
		await fireEvent.click(screen.getByRole('button', { name: 'Save & apply' }));
		await waitFor(() => expect(server.calls.some((c) => c.url === '/api/rules/apply')).toBe(true));
		const order = writes().map((c) => c.url);
		expect(order).toEqual(['/api/rules/exact', '/api/rules/apply']);
		expect(writes()[1].body).toEqual({ ruleIds: ['exact'] });
		await waitFor(() => expect(screen.getByRole('heading', { name: 'Applied' })).toBeTruthy());
	});

	it('applies nothing when the save was refused', async () => {
		page([exact]);
		server.problems = [{ field: 'name', message: 'Give the rule a name.' }];
		await fireEvent.click(screen.getByRole('button', { name: 'Save & apply' }));
		await waitFor(() => expect(screen.getByText('Give the rule a name.')).toBeTruthy());
		await new Promise((r) => setTimeout(r, 50));
		expect(server.calls.some((c) => c.url === '/api/rules/apply')).toBe(false);
	});

	it('switches a rule on and off from the list', async () => {
		page([exact]);
		await fireEvent.click(screen.getByRole('button', { name: 'Disable rule' }));
		await waitFor(() => expect(writes()).toEqual([{ method: 'PATCH', url: '/api/rules/exact', body: { enabled: false } }]));
		await waitFor(() => expect(screen.getByRole('button', { name: 'Enable rule' })).toBeTruthy());
	});

	it('deletes a rule when asked', async () => {
		vi.stubGlobal('confirm', () => true);
		page([exact, flagged]);
		await fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
		await waitFor(() => expect(writes()).toEqual([{ method: 'DELETE', url: '/api/rules/exact', body: undefined }]));
		await waitFor(() => expect(screen.queryByText('Receipts')).toBeNull());
	});

	it('counts what the rule matches, and says how much of the Inbox it looked at', async () => {
		page([exact]);
		server.preview = { matched: 12, scanned: 500, total: 900 };
		await waitFor(() => expect(screen.getByText(/of your newest 500 Inbox messages match this rule/)).toBeTruthy(), { timeout: 2000 });
		expect(screen.getByText('12')).toBeTruthy();
	});
});

describe('Needs your attention', () => {
	it('lists a rule that had a Jev condition, with what it said, and no switch', async () => {
		page([exact, flagged]);
		const list = attentionList();
		expect(within(list).getByText('Invoices')).toBeTruthy();
		expect(within(list).queryByText('Receipts')).toBeNull();
		expect(within(list).queryByRole('button', { name: /able rule/ })).toBeNull();

		await fireEvent.click(within(list).getByText('Invoices'));
		expect(screen.getByText('This rule is switched off')).toBeTruthy();
		expect(screen.getByText('From contains “billing@”')).toBeTruthy();
		expect(screen.getByText('Jev judged: “it’s an invoice or a request for payment” (strict)')).toBeTruthy();
	});

	it('shows no such heading when every rule is an ordinary one', () => {
		page([exact]);
		expect(screen.queryByRole('heading', { name: 'Needs your attention' })).toBeNull();
	});

	it('saves a flagged rule as an exact rule, once its owner agrees to drop what Jev judged', async () => {
		const asked = vi.fn(() => true);
		vi.stubGlobal('confirm', asked);
		page([flagged]);
		await fireEvent.click(screen.getByRole('button', { name: 'Save as exact rule' }));
		await waitFor(() => expect(writes()).toHaveLength(1));
		expect(asked).toHaveBeenCalledWith(
			'This rule also required: “it’s an invoice or a request for payment”. Save it without that?'
		);
		expect(writes()[0]).toMatchObject({
			method: 'PATCH',
			url: '/api/rules/flagged',
			body: { rewrite: true, conditions: flagged.conditions, target: { kind: 'none' }, markRead: true }
		});
		expect(writes()[0].body).not.toHaveProperty('attention');
		await waitFor(() => expect(screen.queryByRole('heading', { name: 'Needs your attention' })).toBeNull());
	});

	it('sends nothing when the owner keeps what Jev judged', async () => {
		vi.stubGlobal('confirm', vi.fn(() => false));
		page([flagged]);
		await fireEvent.click(screen.getByRole('button', { name: 'Save as exact rule' }));
		await new Promise((r) => setTimeout(r, 10));
		expect(writes()).toEqual([]);
	});

	it('renames a flagged rule on plain Save, leaving it flagged and off', async () => {
		page([flagged]);
		await fireEvent.input(screen.getByLabelText('Name'), { target: { value: 'Bills' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		await waitFor(() => expect(writes()).toHaveLength(1));
		expect(writes()[0]).toEqual({ method: 'PATCH', url: '/api/rules/flagged', body: { name: 'Bills' } });
		await waitFor(() => expect(within(attentionList()).getByText('Bills')).toBeTruthy());
		expect(server.rules[0]).toMatchObject({ name: 'Bills', enabled: false, attention: 'jev_condition' });
	});

	it('notes a rule that lost only its tab, leaves it running, and dismisses the note on "Got it"', async () => {
		page([exact, tabRemoved]);
		await fireEvent.click(screen.getByText('Work mail'));
		expect(within(screen.getByText('Work mail').closest('li') as HTMLElement).getByRole('button', { name: 'Disable rule' })).toBeTruthy();
		expect(screen.getByText('This rule no longer puts mail in the Newsletters tab.')).toBeTruthy();
		await fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
		await waitFor(() => expect(writes()).toEqual([{ method: 'POST', url: '/api/rules/tab-removed/dismiss', body: undefined }]));
		await waitFor(() => expect(screen.queryByRole('heading', { name: 'Needs your attention' })).toBeNull());
	});

	it('says why a rule became several, and dismisses that note', async () => {
		page([splitRow]);
		expect(screen.getByText('This rule filed mail in several places, so it is now 2 rules.')).toBeTruthy();
		await fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
		await waitFor(() => expect(writes()).toEqual([{ method: 'POST', url: '/api/rules/split~2/dismiss', body: undefined }]));
	});

	it('says which pin a rule became, offers nothing to edit, and removes it on "Got it"', async () => {
		page([exact, becamePin]);
		await fireEvent.click(within(attentionList()).getByText('Amazon to Promotions'));
		expect(screen.getByText('This rule became a sender pin: @amazon.co → Promotions.')).toBeTruthy();
		expect(screen.getByText(/The pin acts on new mail from any address at amazon\.co/)).toBeTruthy();
		expect(screen.queryByLabelText('Name')).toBeNull();
		await fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
		await waitFor(() => expect(writes()).toEqual([{ method: 'POST', url: '/api/rules/became-pin/dismiss', body: undefined }]));
		await waitFor(() => expect(screen.queryByText('Amazon to Promotions')).toBeNull());
	});

	it('says why a tab rule wasn’t pinned, and pins it with one call', async () => {
		page([exact, pinnedElsewhere]);
		await fireEvent.click(screen.getByText('Shop news to Updates'));
		expect(
			screen.getByText('news@shop.example is already pinned to Promotions, which was kept. This rule’s tab (Updates) is no longer applied.')
		).toBeTruthy();
		await fireEvent.click(screen.getByRole('button', { name: 'Pin to Updates instead' }));
		await waitFor(() => expect(writes()).toEqual([{ method: 'POST', url: '/api/rules/pinned-elsewhere/pin', body: undefined }]));
		await waitFor(() => expect(screen.queryByText('Shop news to Updates')).toBeNull());
	});

	it('keeps the rule when the pin couldn’t be saved', async () => {
		page([pinnedElsewhere]);
		server.pinsWork = false;
		await fireEvent.click(screen.getByRole('button', { name: 'Pin to Updates instead' }));
		await waitFor(() => expect(screen.getByText('Unknown account')).toBeTruthy());
		expect(screen.getByRole('heading', { name: 'Needs your attention' })).toBeTruthy();
	});

	it('offers no one-click pin for a tab rule that names no sender', () => {
		page([tabOnly]);
		expect(screen.queryByRole('button', { name: /^Pin / })).toBeNull();
		expect(screen.getByText('Rules can’t set a tab any more. This one can’t be turned into a sender pin automatically.')).toBeTruthy();
		expect(screen.getByText('Subject contains “digest”')).toBeTruthy();
	});
});
