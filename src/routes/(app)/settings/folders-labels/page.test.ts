// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';

const nav = vi.hoisted(() => ({ invalidateAll: vi.fn(), goto: vi.fn() }));
vi.mock('$app/navigation', () => nav);
const app = vi.hoisted(() => ({ page: { url: new URL('http://localhost/settings/folders-labels'), data: { mailboxMeta: {} } } }));
vi.mock('$app/state', () => app);

import type { Mailbox } from '$lib/jmap/types';
import type { Label } from '$lib/types/labels';
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
	app.page.url = new URL('http://localhost/settings/folders-labels');
	nav.goto.mockClear();
	nav.invalidateAll.mockClear();
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

const box = (id: string, name: string, extra: Partial<Mailbox> = {}): Mailbox =>
	({ id, name, role: null, parentId: null, sortOrder: 0, totalEmails: 0, unreadEmails: 0, ...extra }) as Mailbox;
const mailboxes = [
	box('IN', 'Inbox', { role: 'inbox', unreadEmails: 4 }),
	box('SN', 'Sent', { role: 'sent' }),
	box('TR', 'Trash', { role: 'trash' }),
	box('RCPT', 'Receipts', { sortOrder: 10, unreadEmails: 2 }),
	box('PRJ', 'Projects', { sortOrder: 20 }),
	box('CLI', 'Clients', { parentId: 'PRJ', sortOrder: 10 }),
	box('LBLS', 'Labels'),
	box('WORK', 'Work', { parentId: 'LBLS', sortOrder: 10 }),
	box('HOME', 'Home', { parentId: 'LBLS', sortOrder: 20 })
];
const labels: Label[] = [
	{ id: 'WORK', name: 'Work', color: '#3B82F6' },
	{ id: 'HOME', name: 'Home', color: '#10B981' }
];

/** A small API: the page's requests, answered from `server`, and recorded. */
const server = {
	rules: [] as Rule[],
	calls: [] as { method: string; url: string; body: unknown }[],
	problems: null as unknown[] | null,
	pinsWork: true,
	folderError: null as string | null,
	preview: { matched: 3, scanned: 3, total: 3 } as Record<string, number>
};
const writes = () => server.calls.filter((c) => c.method !== 'GET' && !c.url.endsWith('/preview'));
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

function stubFetch(rules: Rule[]) {
	server.rules = structuredClone(rules);
	server.calls = [];
	server.problems = null;
	server.pinsWork = true;
	server.folderError = null;
	server.preview = { matched: 3, scanned: 3, total: 3 };
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string, init?: RequestInit) => {
			const method = init?.method ?? 'GET';
			const body = init?.body ? JSON.parse(String(init.body)) : undefined;
			server.calls.push({ method, url, body });
			if (url === '/api/folders') {
				if (server.folderError) return new Response(JSON.stringify({ success: false, error: server.folderError }), { status: 400 });
				return ok({ success: true, id: body.action === 'create' ? 'NEW' : undefined, mailboxes, rulesDeleted: 0, rulesKept: 0 });
			}
			if (url.startsWith('/api/mailboxes/')) return ok({ mailboxId: 'x' });
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
	return render(Page, {
		props: { data: { rules: structuredClone(rules), labels, mailboxes, mailboxMeta: { RCPT: { color: '#E11D48', icon: null, iconNode: null, displayName: null } } } } as never
	});
};

const region = (name: string) => screen.getByRole('region', { name });
const attentionList = () => region('Needs your attention');
const allRules = () => region('All rules, in order');
const dialog = () => screen.getByRole('dialog');
/** The names in "All rules, in order", top first. */
const listed = () => [...allRules().querySelectorAll('li')].map((li) => li.querySelector('.text-sm')?.textContent);
const ruleRow = (name: string) => within(within(allRules()).getByText(name).closest('li') as HTMLElement);
const mailboxRow = (section: string, name: string) => within(within(region(section)).getByRole('group', { name }));

async function openAllRules() {
	await fireEvent.click(screen.getByRole('button', { name: 'All rules, in order' }));
}
async function openFromList(name: string) {
	await openAllRules();
	await fireEvent.click(within(allRules()).getByText(name));
}
async function openRow(section: string, name: string) {
	await fireEvent.click(mailboxRow(section, name).getByRole('button', { expanded: false }));
}

// Each test below that carries a "was:" note is one of the rules page's
// tests, moved here when that page became this one.
describe('Folders & labels: the rules', () => {
	// was: lists each rule as conditions → target, saying when the target is missing
	it('lists each rule as conditions → target, saying when the target is missing', async () => {
		page([exact, base('gone', 'Gone', { target: { kind: 'folder', mailboxId: 'DELETED' } }), splitRow]);
		await openAllRules();
		const list = within(allRules());
		expect(list.getByText('From contains “shop.example” → Receipts')).toBeTruthy();
		expect(list.getByText('From contains “shop.example” → target missing')).toBeTruthy();
		expect(list.getByText('From contains “shop.example” → Work')).toBeTruthy();
	});

	// was: sends nothing while a rule is edited, until Save
	it('sends nothing while a rule is edited, until Save', async () => {
		page([exact]);
		await openFromList('Receipts');
		await fireEvent.input(within(dialog()).getByLabelText('Name'), { target: { value: 'Renamed' } });
		await fireEvent.click(within(dialog()).getByLabelText('Star'));
		expect(writes()).toEqual([]);

		await fireEvent.click(within(dialog()).getByRole('button', { name: 'Save' }));
		await waitFor(() => expect(writes()).toHaveLength(1));
		expect(writes()[0]).toMatchObject({ method: 'PATCH', url: '/api/rules/exact', body: { name: 'Renamed', star: true } });
		await waitFor(() => expect(within(allRules()).getByText('Renamed')).toBeTruthy());
		expect(screen.queryByRole('dialog')).toBeNull();
	});

	// was: creates a new rule only on Save, with one place to file it
	it('creates a new rule only on Save, with one place to file it, starting from nowhere', async () => {
		page([]);
		await openAllRules();
		await fireEvent.click(within(allRules()).getByRole('button', { name: 'New rule' }));
		expect((within(dialog()).getByLabelText('File it in') as HTMLSelectElement).value).toBe('none');
		await fireEvent.input(within(dialog()).getByLabelText('Name'), { target: { value: 'Shop' } });
		await fireEvent.input(within(dialog()).getByLabelText('Value'), { target: { value: 'shop.example' } });
		await fireEvent.change(within(dialog()).getByLabelText('File it in'), { target: { value: 'label:WORK' } });
		expect(writes()).toEqual([]);
		await fireEvent.click(within(dialog()).getByRole('button', { name: 'Save' }));
		await waitFor(() => expect(writes()).toHaveLength(1));
		expect(writes()[0]).toMatchObject({
			method: 'POST',
			url: '/api/rules',
			body: { name: 'Shop', target: { kind: 'label', mailboxId: 'WORK' }, markRead: false, star: false, stop: false }
		});
	});

	// was: shows what the server found wrong beside the field it is about
	it('shows what the server found wrong beside the field it is about', async () => {
		page([exact]);
		await openFromList('Receipts');
		server.problems = [
			{ field: 'name', message: 'Give the rule a name.' },
			{ field: 'conditions', index: 0, message: 'Keep this to 500 characters or fewer.' },
			{ field: 'target', message: 'Pick a folder: the one chosen no longer exists.' }
		];
		await fireEvent.click(within(dialog()).getByRole('button', { name: 'Save' }));
		await waitFor(() => expect(within(dialog()).getByText('Give the rule a name.')).toBeTruthy());
		expect(within(dialog()).getByText('Keep this to 500 characters or fewer.')).toBeTruthy();
		expect(within(dialog()).getByText('Pick a folder: the one chosen no longer exists.')).toBeTruthy();
	});

	// was: moves a rule up and down through reorder
	it('moves a rule up and down through reorder', async () => {
		const [a, b, c] = ['a', 'b', 'c'].map((id) => base(id, id.toUpperCase()));
		page([a, b, c]);
		await openAllRules();

		await fireEvent.click(ruleRow('C').getByRole('button', { name: 'Move C up' }));
		await waitFor(() => expect(listed()).toEqual(['A', 'C', 'B']));
		expect(writes()).toEqual([{ method: 'POST', url: '/api/rules/reorder', body: { ids: ['a', 'c', 'b'] } }]);

		await fireEvent.click(ruleRow('A').getByRole('button', { name: 'Move A down' }));
		await waitFor(() => expect(listed()).toEqual(['C', 'A', 'B']));
		expect((ruleRow('C').getByRole('button', { name: 'Move C up' }) as HTMLButtonElement).disabled).toBe(true);
		expect((ruleRow('B').getByRole('button', { name: 'Move B down' }) as HTMLButtonElement).disabled).toBe(true);
	});

	// was: moves a rule past the next rule that runs, a split rule’s second half included
	it('moves a rule past the next rule that runs, a split rule’s second half included', async () => {
		const a = base('a', 'A', { target: { kind: 'label', mailboxId: 'WORK' } });
		const a2 = base('a~2', 'A too', { target: { kind: 'folder', mailboxId: 'RCPT' }, stop: true, attention: 'split', note: { splitInto: 2 } });
		page([a, a2, base('b', 'B')]);
		await openAllRules();
		await fireEvent.click(ruleRow('B').getByRole('button', { name: 'Move B up' }));
		await waitFor(() => expect(writes()).toHaveLength(1));
		expect(writes()[0].body).toEqual({ ids: ['a', 'b', 'a~2'] });
	});

	// was: moves past a rule waiting under "Needs your attention", leaving it where it is
	it('moves past a rule waiting under "Needs your attention", leaving it where it is', async () => {
		const f = { ...flagged, id: 'f' };
		page([base('a', 'A'), f, base('b', 'B')]);
		await openAllRules();
		expect(within(attentionList()).queryByRole('button', { name: /Move/ })).toBeNull();
		expect(within(allRules()).queryByText('Invoices')).toBeNull();
		expect((ruleRow('A').getByRole('button', { name: 'Move A up' }) as HTMLButtonElement).disabled).toBe(true);
		await fireEvent.click(ruleRow('B').getByRole('button', { name: 'Move B up' }));
		await waitFor(() => expect(writes()).toHaveLength(1));
		expect(writes()[0].body).toEqual({ ids: ['b', 'f', 'a'] });
	});

	// was: lists a split rule and one that lost its tab where they run, each with its note and "Got it"
	it('lists a split rule and one that lost its tab where they run, each with its note and "Got it"', async () => {
		page([exact, splitRow, base('c', 'C'), tabRemoved]);
		expect(screen.queryByRole('heading', { name: 'Needs your attention' })).toBeNull();
		await openAllRules();
		expect(listed()).toEqual(['Receipts', 'Shop', 'C', 'Work mail']);
		expect(ruleRow('Shop').getByText('One of 2 rules a rule filing in several places became.')).toBeTruthy();
		expect(ruleRow('Work mail').getByText('No longer puts mail in the Newsletters tab.')).toBeTruthy();
		await fireEvent.click(ruleRow('Shop').getByRole('button', { name: 'Got it' }));
		await waitFor(() => expect(writes()).toEqual([{ method: 'POST', url: '/api/rules/split~2/dismiss', body: undefined }]));
		await waitFor(() => expect(ruleRow('Shop').queryByRole('button', { name: 'Got it' })).toBeNull());
		expect(listed()).toEqual(['Receipts', 'Shop', 'C', 'Work mail']);
	});

	// was: disables moving while a change is being saved
	it('disables moving while a change is being saved', async () => {
		page([base('a', 'A'), base('b', 'B'), base('c', 'C')]);
		await openAllRules();
		let release!: () => void;
		const realFetch = globalThis.fetch;
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string, init?: RequestInit) => {
				if (url === '/api/rules/reorder') await new Promise<void>((r) => (release = r));
				return realFetch(url, init);
			})
		);
		await fireEvent.click(ruleRow('B').getByRole('button', { name: 'Move B up' }));
		await waitFor(() => expect((ruleRow('C').getByRole('button', { name: 'Move C up' }) as HTMLButtonElement).disabled).toBe(true));
		expect((ruleRow('C').getByRole('switch') as HTMLButtonElement).disabled).toBe(true);
		release();
		await waitFor(() => expect((ruleRow('C').getByRole('button', { name: 'Move C up' }) as HTMLButtonElement).disabled).toBe(false));
	});

	// was: saves, then applies the saved rule by its id
	it('saves, then applies the saved rule by its id', async () => {
		page([exact]);
		await openFromList('Receipts');
		await fireEvent.click(within(dialog()).getByRole('button', { name: 'Save & apply' }));
		await waitFor(() => expect(server.calls.some((c) => c.url === '/api/rules/apply')).toBe(true));
		const order = writes().map((c) => c.url);
		expect(order).toEqual(['/api/rules/exact', '/api/rules/apply']);
		expect(writes()[1].body).toEqual({ ruleIds: ['exact'] });
		await waitFor(() => expect(screen.getByRole('heading', { name: 'Applied' })).toBeTruthy());
		await fireEvent.click(screen.getByRole('button', { name: 'Done' }));
		await waitFor(() => expect(screen.queryByRole('heading', { name: 'Applied' })).toBeNull());
	});

	// was: applies nothing when the save was refused
	it('applies nothing when the save was refused', async () => {
		page([exact]);
		await openFromList('Receipts');
		server.problems = [{ field: 'name', message: 'Give the rule a name.' }];
		await fireEvent.click(within(dialog()).getByRole('button', { name: 'Save & apply' }));
		await waitFor(() => expect(screen.getByText('Give the rule a name.')).toBeTruthy());
		await new Promise((r) => setTimeout(r, 50));
		expect(server.calls.some((c) => c.url === '/api/rules/apply')).toBe(false);
		expect(screen.getByRole('dialog')).toBeTruthy();
	});

	// was: switches a rule on and off from the list
	it('switches a rule on and off from the list', async () => {
		page([exact]);
		await openAllRules();
		const toggle = () => ruleRow('Receipts').getByRole('switch', { name: 'Receipts' });
		expect(toggle().getAttribute('aria-checked')).toBe('true');
		await fireEvent.click(toggle());
		await waitFor(() => expect(writes()).toEqual([{ method: 'PATCH', url: '/api/rules/exact', body: { enabled: false } }]));
		await waitFor(() => expect(toggle().getAttribute('aria-checked')).toBe('false'));
	});

	// was: deletes a rule when asked
	it('deletes a rule when asked', async () => {
		vi.stubGlobal('confirm', () => true);
		page([exact, flagged]);
		await openFromList('Receipts');
		await fireEvent.click(within(dialog()).getByRole('button', { name: 'Delete' }));
		await waitFor(() => expect(writes()).toEqual([{ method: 'DELETE', url: '/api/rules/exact', body: undefined }]));
		await waitFor(() => expect(within(allRules()).queryByText('Receipts')).toBeNull());
		expect(screen.queryByRole('dialog')).toBeNull();
	});

	// was: counts what the rule matches, and says how much of the Inbox it looked at
	it('counts what the rule matches, and says how much of the Inbox it looked at', async () => {
		page([exact]);
		server.preview = { matched: 12, scanned: 500, total: 900 };
		await openFromList('Receipts');
		await waitFor(() => expect(within(dialog()).getByText(/of your newest 500 Inbox messages match this rule/)).toBeTruthy(), {
			timeout: 2000
		});
		expect(within(dialog()).getByText('12')).toBeTruthy();
	});
});

describe('Folders & labels: Needs your attention', () => {
	// was: lists a rule that had a Jev condition, with what it said, and no switch
	it('lists a rule that had a Jev condition, with what it said, and no switch', async () => {
		page([exact, flagged]);
		const list = attentionList();
		expect(within(list).getByText('Invoices')).toBeTruthy();
		expect(within(list).queryByText('Receipts')).toBeNull();
		expect(within(list).queryByRole('switch')).toBeNull();

		await fireEvent.click(within(list).getByText('Invoices'));
		expect(within(dialog()).getByText('This rule is switched off')).toBeTruthy();
		expect(within(dialog()).getByText('From contains “billing@”')).toBeTruthy();
		expect(within(dialog()).getByText('Jev judged: “it’s an invoice or a request for payment” (strict)')).toBeTruthy();
	});

	// was: shows no such heading when every rule is an ordinary one
	it('shows no such heading when every rule is an ordinary one', () => {
		page([exact]);
		expect(screen.queryByRole('heading', { name: 'Needs your attention' })).toBeNull();
	});

	// was: saves a flagged rule as an exact rule, once its owner agrees to drop what Jev judged
	it('saves a flagged rule as an exact rule, once its owner agrees to drop what Jev judged', async () => {
		const asked = vi.fn(() => true);
		vi.stubGlobal('confirm', asked);
		page([flagged]);
		await fireEvent.click(within(attentionList()).getByText('Invoices'));
		await fireEvent.click(within(dialog()).getByRole('button', { name: 'Save as exact rule' }));
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

	// was: sends nothing when the owner keeps what Jev judged
	it('sends nothing when the owner keeps what Jev judged', async () => {
		vi.stubGlobal('confirm', vi.fn(() => false));
		page([flagged]);
		await fireEvent.click(within(attentionList()).getByText('Invoices'));
		await fireEvent.click(within(dialog()).getByRole('button', { name: 'Save as exact rule' }));
		await new Promise((r) => setTimeout(r, 10));
		expect(writes()).toEqual([]);
	});

	// was: renames a flagged rule on plain Save, leaving it flagged and off
	it('renames a flagged rule on plain Save, leaving it flagged and off', async () => {
		page([flagged]);
		await fireEvent.click(within(attentionList()).getByText('Invoices'));
		await fireEvent.input(within(dialog()).getByLabelText('Name'), { target: { value: 'Bills' } });
		await fireEvent.click(within(dialog()).getByRole('button', { name: 'Save' }));
		await waitFor(() => expect(writes()).toHaveLength(1));
		expect(writes()[0]).toEqual({ method: 'PATCH', url: '/api/rules/flagged', body: { name: 'Bills' } });
		await waitFor(() => expect(within(attentionList()).getByText('Bills')).toBeTruthy());
		expect(server.rules[0]).toMatchObject({ name: 'Bills', enabled: false, attention: 'jev_condition' });
	});

	// was: notes a rule that lost only its tab, leaves it running, and dismisses the note on "Got it"
	it('notes a rule that lost only its tab, leaves it running, and dismisses the note on "Got it"', async () => {
		page([exact, tabRemoved]);
		await openFromList('Work mail');
		expect(within(dialog()).getByText('This rule no longer puts mail in the Newsletters tab.')).toBeTruthy();
		await fireEvent.click(within(dialog()).getByRole('button', { name: 'Close' }));
		expect(ruleRow('Work mail').getByRole('switch', { name: 'Work mail' })).toBeTruthy();
		await fireEvent.click(ruleRow('Work mail').getByRole('button', { name: 'Got it' }));
		await waitFor(() => expect(writes()).toEqual([{ method: 'POST', url: '/api/rules/tab-removed/dismiss', body: undefined }]));
		await waitFor(() => expect(within(allRules()).queryByText('No longer puts mail in the Newsletters tab.')).toBeNull());
		expect(screen.queryByRole('heading', { name: 'Needs your attention' })).toBeNull();
	});

	// was: says why a rule became several, and dismisses that note
	it('says why a rule became several, and dismisses that note', async () => {
		page([splitRow]);
		await openFromList('Shop');
		expect(within(dialog()).getByText('This rule filed mail in several places, so it is now 2 rules.')).toBeTruthy();
		await fireEvent.click(within(dialog()).getByRole('button', { name: 'Close' }));
		await fireEvent.click(ruleRow('Shop').getByRole('button', { name: 'Got it' }));
		await waitFor(() => expect(writes()).toEqual([{ method: 'POST', url: '/api/rules/split~2/dismiss', body: undefined }]));
	});

	// was: says which pin a rule became, offers nothing to edit, and removes it on "Got it"
	it('says which pin a rule became, offers nothing to edit, and removes it on "Got it"', async () => {
		page([exact, becamePin]);
		await fireEvent.click(within(attentionList()).getByText('Amazon to Promotions'));
		expect(within(dialog()).getByText('This rule became a sender pin: @amazon.co → Promotions.')).toBeTruthy();
		expect(within(dialog()).getByText(/The pin acts on new mail from any address at amazon\.co/)).toBeTruthy();
		expect(within(dialog()).queryByLabelText('Name')).toBeNull();
		await fireEvent.click(within(dialog()).getByRole('button', { name: 'Got it' }));
		await waitFor(() => expect(writes()).toEqual([{ method: 'POST', url: '/api/rules/became-pin/dismiss', body: undefined }]));
		await waitFor(() => expect(screen.queryByText('Amazon to Promotions')).toBeNull());
		expect(screen.queryByRole('dialog')).toBeNull();
	});

	// was: says why a tab rule wasn’t pinned, and pins it with one call
	it('says why a tab rule wasn’t pinned, and pins it with one call', async () => {
		page([exact, pinnedElsewhere]);
		await fireEvent.click(within(attentionList()).getByText('Shop news to Updates'));
		expect(
			within(dialog()).getByText('news@shop.example is already pinned to Promotions, which was kept. This rule’s tab (Updates) is no longer applied.')
		).toBeTruthy();
		await fireEvent.click(within(dialog()).getByRole('button', { name: 'Pin to Updates instead' }));
		await waitFor(() => expect(writes()).toEqual([{ method: 'POST', url: '/api/rules/pinned-elsewhere/pin', body: undefined }]));
		await waitFor(() => expect(screen.queryByText('Shop news to Updates')).toBeNull());
	});

	// was: keeps the rule when the pin couldn’t be saved
	it('keeps the rule when the pin couldn’t be saved', async () => {
		page([pinnedElsewhere]);
		server.pinsWork = false;
		await fireEvent.click(within(attentionList()).getByText('Shop news to Updates'));
		await fireEvent.click(within(dialog()).getByRole('button', { name: 'Pin to Updates instead' }));
		await waitFor(() => expect(within(dialog()).getByRole('alert').textContent).toBe('Unknown account'));
		expect(screen.getByRole('heading', { name: 'Needs your attention' })).toBeTruthy();
	});

	// was: offers no one-click pin for a tab rule that names no sender
	it('offers no one-click pin for a tab rule that names no sender', async () => {
		page([tabOnly]);
		await fireEvent.click(within(attentionList()).getByText('Digests to Updates'));
		expect(within(dialog()).queryByRole('button', { name: /^Pin / })).toBeNull();
		expect(
			within(dialog()).getByText('Rules can’t set a tab any more. This one can’t be turned into a sender pin automatically.')
		).toBeTruthy();
		expect(within(dialog()).getByText('Subject contains “digest”')).toBeTruthy();
	});
});

describe('Folders & labels: folders and labels with their rules', () => {
	it('shows the folders as a tree, the labels as a list, and the system folders apart', () => {
		page([]);
		const folders = within(region('Folders'));
		expect(folders.getAllByRole('group').map((g) => g.getAttribute('aria-label'))).toEqual(['Receipts', 'Projects', 'Clients']);
		const indent = (name: string) => (folders.getByRole('group', { name }).firstElementChild as HTMLElement).style.paddingLeft;
		expect([indent('Receipts'), indent('Projects'), indent('Clients')]).toEqual(['0px', '0px', '16px']);
		expect(folders.getByText('2 unread')).toBeTruthy();

		const labelRows = within(region('Labels')).getAllByRole('group').map((g) => g.getAttribute('aria-label'));
		expect(labelRows).toEqual(['Work', 'Home']);
		const system = within(region('System folders')).getAllByRole('group').map((g) => g.getAttribute('aria-label'));
		expect(system).toEqual(['Inbox', 'Sent', 'Trash']);
		// Not editable, and only Trash of these can be filed into.
		expect(within(region('System folders')).queryByRole('button', { name: /Edit|Delete/ })).toBeNull();
		expect(mailboxRow('System folders', 'Inbox').queryByRole('button', { expanded: false })).toBeNull();
		expect(mailboxRow('System folders', 'Trash').getByRole('button', { expanded: false })).toBeTruthy();
	});

	it('says how many rules file into a folder or label', () => {
		page([exact, base('r2', 'More receipts', { target: { kind: 'folder', mailboxId: 'RCPT' } }), splitRow]);
		expect(mailboxRow('Folders', 'Receipts').getByText('· 2 rules')).toBeTruthy();
		expect(mailboxRow('Labels', 'Work').getByText('1 rule')).toBeTruthy();
		expect(mailboxRow('Labels', 'Home').queryByText(/rule/)).toBeNull();
	});

	it('lists exactly the rules that file into a row when it is opened', async () => {
		const trashRule = base('t', 'Spam words', { target: { kind: 'trash' } });
		page([exact, splitRow, trashRule, base('n', 'Mark shop read'), { ...flagged, target: { kind: 'folder', mailboxId: 'RCPT' } }]);
		await openRow('Folders', 'Receipts');
		const names = (section: string, name: string) =>
			[...within(region(section)).getByRole('group', { name }).querySelectorAll('li')].map((li) => li.querySelector('.text-sm')?.textContent);
		expect(names('Folders', 'Receipts')).toEqual(['Receipts', 'Invoices']);
		expect(mailboxRow('Folders', 'Receipts').getByText('From contains “shop.example”')).toBeTruthy();
		// A rule switched off by an upgrade has no switch here either.
		expect(mailboxRow('Folders', 'Receipts').getAllByRole('switch')).toHaveLength(1);
		await openRow('Labels', 'Work');
		expect(names('Labels', 'Work')).toEqual(['Shop']);
		await openRow('System folders', 'Trash');
		expect(names('System folders', 'Trash')).toEqual(['Spam words']);
		await openRow('Labels', 'Home');
		expect(mailboxRow('Labels', 'Home').getByText('No rules file mail here yet.')).toBeTruthy();
	});

	it('opens a rule from its folder, and switches it from there', async () => {
		page([exact]);
		await openRow('Folders', 'Receipts');
		await fireEvent.click(mailboxRow('Folders', 'Receipts').getByRole('switch', { name: 'Receipts' }));
		await waitFor(() => expect(writes()).toEqual([{ method: 'PATCH', url: '/api/rules/exact', body: { enabled: false } }]));
		await fireEvent.click(mailboxRow('Folders', 'Receipts').getByText('From contains “shop.example”'));
		expect(within(dialog()).getByRole('heading', { name: 'Receipts' })).toBeTruthy();
	});

	for (const [section, row, key, target] of [
		['Folders', 'Projects', 'folder:PRJ', { kind: 'folder', mailboxId: 'PRJ' }],
		['Labels', 'Home', 'label:HOME', { kind: 'label', mailboxId: 'HOME' }],
		['System folders', 'Trash', 'trash', { kind: 'trash' }]
	] as const) {
		it(`starts a rule from ${row}, filing into it, and saves it there`, async () => {
			page([]);
			await openRow(section, row);
			await fireEvent.click(mailboxRow(section, row).getByRole('button', { name: 'Add rule' }));
			expect(within(dialog()).getByRole('heading', { name: 'New rule' })).toBeTruthy();
			expect((within(dialog()).getByLabelText('File it in') as HTMLSelectElement).value).toBe(key);
			await fireEvent.input(within(dialog()).getByLabelText('Name'), { target: { value: 'From the shop' } });
			await fireEvent.input(within(dialog()).getByLabelText('Value'), { target: { value: 'shop.example' } });
			await fireEvent.click(within(dialog()).getByRole('button', { name: 'Save' }));
			await waitFor(() => expect(writes()).toHaveLength(1));
			expect(writes()[0]).toMatchObject({ method: 'POST', url: '/api/rules', body: { name: 'From the shop', target } });
			await waitFor(() => expect(mailboxRow(section, row).getByText('From the shop')).toBeTruthy());
		});
	}

	it('lets a rule started from a folder file somewhere else', async () => {
		page([]);
		await openRow('Folders', 'Receipts');
		await fireEvent.click(mailboxRow('Folders', 'Receipts').getByRole('button', { name: 'Add rule' }));
		await fireEvent.input(within(dialog()).getByLabelText('Name'), { target: { value: 'Work' } });
		await fireEvent.input(within(dialog()).getByLabelText('Value'), { target: { value: 'work.example' } });
		await fireEvent.change(within(dialog()).getByLabelText('File it in'), { target: { value: 'label:WORK' } });
		await fireEvent.click(within(dialog()).getByRole('button', { name: 'Save' }));
		await waitFor(() => expect(writes()).toHaveLength(1));
		expect(writes()[0].body).toMatchObject({ target: { kind: 'label', mailboxId: 'WORK' } });
	});

	it('shows a rule that files nowhere only under "All rules, in order"', async () => {
		page([base('n', 'Mark shop read'), base('s', 'Stop here', { markRead: false, stop: true })]);
		for (const section of ['Folders', 'Labels', 'System folders']) {
			for (const button of within(region(section)).queryAllByRole('button', { expanded: false })) await fireEvent.click(button);
		}
		expect(screen.queryByText('Mark shop read')).toBeNull();
		await openAllRules();
		expect(listed()).toEqual(['Mark shop read', 'Stop here']);
		expect(within(allRules()).getByText('From contains “shop.example” → mark read')).toBeTruthy();
	});

	it('keeps "All rules, in order" closed, and opens it for a link to #rules', async () => {
		page([exact]);
		expect(screen.getByRole('button', { name: 'All rules, in order' }).getAttribute('aria-expanded')).toBe('false');
		expect(within(allRules()).queryByText('Receipts')).toBeNull();
		cleanup();
		app.page.url = new URL('http://localhost/settings/folders-labels#rules');
		page([exact]);
		expect(screen.getByRole('button', { name: 'All rules, in order' }).getAttribute('aria-expanded')).toBe('true');
		expect(within(allRules()).getByText('Receipts')).toBeTruthy();
	});
});

describe('Folders & labels: changing folders and labels', () => {
	beforeEach(() => {
		// The icon picker draws its grid a page at a time as it scrolls, and
		// scrolls back to the top for a new search.
		Element.prototype.scrollTo = () => {};
		vi.stubGlobal(
			'IntersectionObserver',
			class {
				observe() {}
				disconnect() {}
			}
		);
	});

	const folderCalls = () => writes().filter((c) => c.url === '/api/folders');
	const metaCalls = () => writes().filter((c) => c.url.startsWith('/api/mailboxes/'));

	it('creates a folder and a label through /api/folders', async () => {
		page([]);
		await fireEvent.click(screen.getByRole('button', { name: 'New folder' }));
		await fireEvent.input(within(dialog()).getByLabelText('Folder name'), { target: { value: 'Trips' } });
		await fireEvent.click(within(dialog()).getByRole('button', { name: 'Save' }));
		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
		expect(folderCalls()).toEqual([{ method: 'POST', url: '/api/folders', body: { action: 'create', name: 'Trips', parentId: null } }]);

		server.calls = [];
		await fireEvent.click(screen.getByRole('button', { name: 'New label' }));
		await fireEvent.input(within(dialog()).getByLabelText('Label name'), { target: { value: 'Family' } });
		await fireEvent.click(within(dialog()).getByRole('button', { name: 'Save' }));
		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
		expect(folderCalls()).toEqual([{ method: 'POST', url: '/api/folders', body: { action: 'create', kind: 'label', name: 'Family' } }]);
		expect(metaCalls()).toEqual([{ method: 'PATCH', url: '/api/mailboxes/NEW/meta', body: { color: expect.any(String), icon: null } }]);
	});

	it('edits a folder: its name, its place, its color and its icon', async () => {
		page([]);
		await fireEvent.click(mailboxRow('Folders', 'Receipts').getByRole('button', { name: 'Edit Receipts' }));
		await fireEvent.input(within(dialog()).getByLabelText('Folder name'), { target: { value: 'Bills' } });
		await fireEvent.change(within(dialog()).getByRole('combobox'), { target: { value: 'PRJ' } });
		await fireEvent.click(within(dialog()).getByRole('button', { name: 'Teal' }));
		await waitFor(() => expect(within(dialog()).getByRole('option', { name: 'star' })).toBeTruthy(), { timeout: 4000 });
		await fireEvent.click(within(dialog()).getByRole('option', { name: 'star' }));
		await fireEvent.click(within(dialog()).getByRole('button', { name: 'Save' }));
		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
		expect(folderCalls()).toEqual([
			{ method: 'POST', url: '/api/folders', body: { action: 'rename', id: 'RCPT', name: 'Bills' } },
			{ method: 'POST', url: '/api/folders', body: { action: 'move', id: 'RCPT', newParentId: 'PRJ' } }
		]);
		expect(metaCalls()).toEqual([{ method: 'PATCH', url: '/api/mailboxes/RCPT/meta', body: { color: '#14B8A6', icon: 'star' } }]);
	});

	it('edits a label: renamed through /api/folders, and its color cleared with "No color"', async () => {
		page([]);
		await fireEvent.click(mailboxRow('Labels', 'Work').getByRole('button', { name: 'Edit Work' }));
		await fireEvent.input(within(dialog()).getByLabelText('Label name'), { target: { value: 'Office' } });
		await fireEvent.click(within(dialog()).getByRole('button', { name: 'No color' }));
		await fireEvent.click(within(dialog()).getByRole('button', { name: 'Save' }));
		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
		expect(folderCalls()).toEqual([{ method: 'POST', url: '/api/folders', body: { action: 'rename', id: 'WORK', name: 'Office' } }]);
		expect(metaCalls()).toEqual([{ method: 'PATCH', url: '/api/mailboxes/WORK/meta', body: { color: null, icon: null } }]);
	});

	it('deletes a folder, naming what happens to its rules, and reads the rules back', async () => {
		const asked = vi.fn(() => true);
		vi.stubGlobal('confirm', asked);
		page([exact, base('kept', 'Receipts read', { target: { kind: 'folder', mailboxId: 'RCPT' }, markRead: true })]);
		await fireEvent.click(mailboxRow('Folders', 'Receipts').getByRole('button', { name: 'Delete Receipts' }));
		expect(asked).toHaveBeenCalledWith(
			'Delete "Receipts"? Messages inside will not be deleted — move them first if you want to keep them somewhere else. ' +
				'This also deletes 1 rule that files into it. 1 other rule will keep marking mail as read (or starring, or stopping later rules) without filing it.'
		);
		await waitFor(() => expect(folderCalls()).toEqual([{ method: 'POST', url: '/api/folders', body: { action: 'delete', id: 'RCPT' } }]));
		await waitFor(() => expect(server.calls.at(-1)).toMatchObject({ method: 'GET', url: '/api/rules' }));
		expect(nav.invalidateAll).toHaveBeenCalled();
		// Nothing asked of the rules API before the question.
		expect(server.calls.filter((c) => c.url === '/api/rules')).toHaveLength(1);
	});

	it('deletes a label, leaving out a count that is zero', async () => {
		const asked = vi.fn(() => true);
		vi.stubGlobal('confirm', asked);
		page([splitRow]);
		await fireEvent.click(mailboxRow('Labels', 'Work').getByRole('button', { name: 'Delete Work' }));
		expect(asked).toHaveBeenCalledWith('Delete "Work"? Emails tagged with this label will not be deleted. This also deletes 1 rule that files into it.');
		await waitFor(() => expect(folderCalls()).toEqual([{ method: 'POST', url: '/api/folders', body: { action: 'delete', id: 'WORK' } }]));

		asked.mockClear();
		server.calls = [];
		await fireEvent.click(mailboxRow('Labels', 'Home').getByRole('button', { name: 'Delete Home' }));
		expect(asked).toHaveBeenCalledWith('Delete "Home"? Emails tagged with this label will not be deleted.');
	});

	it('sends nothing when a delete is called off', async () => {
		vi.stubGlobal('confirm', () => false);
		page([]);
		await fireEvent.click(mailboxRow('Folders', 'Receipts').getByRole('button', { name: 'Delete Receipts' }));
		await new Promise((r) => setTimeout(r, 10));
		expect(folderCalls()).toEqual([]);
	});

	it('goes to the Inbox when the folder being viewed is deleted', async () => {
		vi.stubGlobal('confirm', () => true);
		app.page.url = new URL('http://localhost/folder/PRJ');
		page([]);
		await fireEvent.click(mailboxRow('Folders', 'Receipts').getByRole('button', { name: 'Delete Receipts' }));
		await waitFor(() => expect(nav.invalidateAll).toHaveBeenCalled());
		expect(nav.goto).not.toHaveBeenCalled();
		await fireEvent.click(mailboxRow('Folders', 'Projects').getByRole('button', { name: 'Delete Projects' }));
		await waitFor(() => expect(nav.goto).toHaveBeenCalledWith('/inbox'));
	});

	it('moves a folder and a label one place up or down among their neighbours', async () => {
		page([]);
		expect((mailboxRow('Folders', 'Receipts').getByRole('button', { name: 'Move Receipts up' }) as HTMLButtonElement).disabled).toBe(true);
		expect((mailboxRow('Folders', 'Clients').getByRole('button', { name: 'Move Clients down' }) as HTMLButtonElement).disabled).toBe(true);
		await fireEvent.click(mailboxRow('Folders', 'Receipts').getByRole('button', { name: 'Move Receipts down' }));
		await waitFor(() =>
			expect(folderCalls()).toEqual([{ method: 'POST', url: '/api/folders', body: { action: 'reorder', id: 'RCPT', parentId: null, beforeId: null } }])
		);
		server.calls = [];
		await fireEvent.click(mailboxRow('Labels', 'Home').getByRole('button', { name: 'Move Home up' }));
		await waitFor(() =>
			expect(folderCalls()).toEqual([{ method: 'POST', url: '/api/folders', body: { action: 'reorder', id: 'HOME', parentId: 'LBLS', beforeId: 'WORK' } }])
		);
		expect(nav.invalidateAll).toHaveBeenCalled();
	});

	it('shows what the server refused in the page, never in an alert', async () => {
		const alert = vi.fn();
		vi.stubGlobal('alert', alert);
		vi.stubGlobal('confirm', () => true);
		page([]);
		server.folderError = 'Remove labels inside this folder first';
		await fireEvent.click(mailboxRow('Folders', 'Receipts').getByRole('button', { name: 'Delete Receipts' }));
		await waitFor(() => expect(within(region('Folders')).getByRole('alert').textContent).toBe('Remove labels inside this folder first'));

		server.folderError = 'Labels stay under Labels';
		await fireEvent.click(mailboxRow('Labels', 'Home').getByRole('button', { name: 'Move Home up' }));
		await waitFor(() => expect(within(region('Labels')).getByRole('alert').textContent).toBe('Labels stay under Labels'));
		expect(nav.invalidateAll).not.toHaveBeenCalled();
		expect(alert).not.toHaveBeenCalled();
	});
});
