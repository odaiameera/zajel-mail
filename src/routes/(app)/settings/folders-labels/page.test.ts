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
const mailboxGroup = (section: string, name: string) => within(region(section)).getByRole('group', { name });
const mailboxRow = (section: string, name: string) => within(mailboxGroup(section, name));
/** The button that opens a row to show its rules: not the one for its menu. Null where no rule can file. */
const rowOpener = (section: string, name: string) =>
	mailboxGroup(section, name).querySelector<HTMLElement>('button[aria-expanded]:not([aria-haspopup])');
/** The handle a folder, a label, or a rule under "All rules, in order" is dragged by. */
const handle = (section: string, name: string) => within(region(section)).getByRole('button', { name: `Reorder ${name}` });
const ruleHandle = (name: string) => handle('All rules, in order', name);
const optionsButton = (section: string, name: string) => mailboxRow(section, name).getByRole('button', { name: `${name} options` });
/** The open menu: it hangs off <body>, not the row. */
const menu = (name: string) => screen.getByRole('menu', { name: `${name} options` });

async function openAllRules() {
	await fireEvent.click(screen.getByRole('button', { name: 'All rules, in order' }));
}
async function openFromList(name: string) {
	await openAllRules();
	await fireEvent.click(within(allRules()).getByText(name));
}
/** The system folders are folded away until asked for. */
async function openSystemFolders() {
	const fold = screen.getByRole('button', { name: 'System folders' });
	if (fold.getAttribute('aria-expanded') === 'false') await fireEvent.click(fold);
}
async function openRow(section: string, name: string) {
	if (section === 'System folders') await openSystemFolders();
	await fireEvent.click(rowOpener(section, name)!);
}
/** Open a row's menu and press View, Edit or Delete in it. */
async function choose(section: string, name: string, item: 'View' | 'Edit' | 'Delete') {
	await fireEvent.click(optionsButton(section, name));
	await fireEvent.click(within(menu(name)).getByRole('menuitem', { name: item }));
}
/** An arrow key on a handle: how a row is moved without a pointer. */
async function arrow(grip: HTMLElement, direction: 'up' | 'down') {
	grip.focus();
	await fireEvent.keyDown(grip, { key: direction === 'up' ? 'ArrowUp' : 'ArrowDown' });
}
/** Let what the last press started finish (a move is not sent while another is on its way). */
const settle = () => new Promise((r) => setTimeout(r, 10));

/** The height each row is given by `layOut`. */
const ROW = 40;
const sortRows = (section: string) => [...region(section).querySelectorAll<HTMLElement>('[data-sort-id]')];
/** jsdom lays nothing out: stack the rows of a list from the top of the page, 40px each. */
function layOut(section: string) {
	sortRows(section).forEach((row, i) => {
		const top = i * ROW;
		row.getBoundingClientRect = () =>
			({ top, bottom: top + ROW, left: 0, right: 300, width: 300, height: ROW, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
	});
}
const sortRow = (section: string, name: string) => handle(section, name).closest<HTMLElement>('[data-sort-id]')!;
/** Press a row's handle and carry it to `ratio` of the way down another row (0 its top, 1 its bottom). */
async function carry(section: string, name: string, onto: string, ratio: number) {
	layOut(section);
	const from = sortRow(section, name).getBoundingClientRect();
	const to = sortRow(section, onto).getBoundingClientRect();
	const y = to.top + to.height * ratio;
	await fireEvent.pointerDown(handle(section, name), { pointerId: 1, button: 0, clientX: 10, clientY: from.top + from.height / 2 });
	await fireEvent.pointerMove(window, { pointerId: 1, clientX: 10, clientY: y });
	return y;
}
/** Drag a row by its handle and let it go on another. */
async function drag(section: string, name: string, onto: string, ratio: number) {
	const y = await carry(section, name, onto, ratio);
	await fireEvent.pointerUp(window, { pointerId: 1, clientX: 10, clientY: y });
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

		await arrow(ruleHandle('C'), 'up');
		await waitFor(() => expect(listed()).toEqual(['A', 'C', 'B']));
		expect(writes()).toEqual([{ method: 'POST', url: '/api/rules/reorder', body: { ids: ['a', 'c', 'b'] } }]);

		await arrow(ruleHandle('A'), 'down');
		await waitFor(() => expect(listed()).toEqual(['C', 'A', 'B']));
		expect(writes()[1]).toEqual({ method: 'POST', url: '/api/rules/reorder', body: { ids: ['c', 'a', 'b'] } });

		// The first has nowhere to go up, nor the last down: nothing is sent.
		await arrow(ruleHandle('C'), 'up');
		await arrow(ruleHandle('B'), 'down');
		await settle();
		expect(writes()).toHaveLength(2);
		expect(listed()).toEqual(['C', 'A', 'B']);
	});

	it('has a handle on each rule and no Move buttons', async () => {
		page([base('a', 'A'), base('b', 'B'), base('', '', { id: 'u' })]);
		await openAllRules();
		const names = within(allRules())
			.getAllByRole('button', { name: /^Reorder / })
			.map((b) => b.getAttribute('aria-label'));
		expect(names).toEqual(['Reorder A', 'Reorder B', 'Reorder Untitled rule']);
		for (const li of allRules().querySelectorAll('li')) {
			expect(li.hasAttribute('data-sort-id')).toBe(true);
			expect(li.querySelector('[data-sort-handle]')).toBe(li.firstElementChild);
			// The handle, the name and what it does, then the switch.
			expect(li.lastElementChild?.getAttribute('role')).toBe('switch');
		}
		expect(screen.queryByRole('button', { name: /^Move / })).toBeNull();
	});

	it('drags a rule to a new place, leaving a rule that needs attention where it is', async () => {
		const f = { ...flagged, id: 'f' };
		page([base('a', 'A'), f, base('b', 'B'), base('c', 'C')]);
		await openAllRules();

		// Onto the top half of the first: before it.
		await drag('All rules, in order', 'C', 'A', 0.25);
		await waitFor(() => expect(listed()).toEqual(['C', 'A', 'B']));
		expect(writes()).toEqual([{ method: 'POST', url: '/api/rules/reorder', body: { ids: ['c', 'f', 'a', 'b'] } }]);

		// Onto the bottom half of the last: after it.
		await drag('All rules, in order', 'C', 'B', 0.75);
		await waitFor(() => expect(listed()).toEqual(['A', 'B', 'C']));
		expect(writes()[1].body).toEqual({ ids: ['a', 'f', 'b', 'c'] });
		expect(document.querySelector('.sort-ghost, [data-sort-dragging], [data-sort-drop]')).toBeNull();
	});

	it('sends nothing for a rule let go where it already is, or when the drag is called off with Escape', async () => {
		page([base('a', 'A'), base('b', 'B'), base('c', 'C')]);
		await openAllRules();
		// After the one before it, and before the one after it: the same place.
		await drag('All rules, in order', 'B', 'A', 0.75);
		await drag('All rules, in order', 'B', 'C', 0.25);

		await carry('All rules, in order', 'A', 'C', 0.75);
		expect(sortRow('All rules, in order', 'A').hasAttribute('data-sort-dragging')).toBe(true);
		expect(sortRow('All rules, in order', 'C').getAttribute('data-sort-drop')).toBe('after');
		expect(document.querySelector('.sort-ghost')).toBeTruthy();
		await fireEvent.keyDown(document.body, { key: 'Escape' });
		await fireEvent.pointerUp(window, { pointerId: 1, clientX: 10, clientY: 110 });
		await settle();
		expect(writes()).toEqual([]);
		expect(listed()).toEqual(['A', 'B', 'C']);
		expect(document.querySelector('.sort-ghost, [data-sort-dragging], [data-sort-drop]')).toBeNull();
	});

	it('shows what the server refused about a new order above the list', async () => {
		page([base('a', 'A'), base('b', 'B')]);
		await openAllRules();
		const realFetch = globalThis.fetch;
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string, init?: RequestInit) =>
				url === '/api/rules/reorder'
					? new Response(JSON.stringify({ error: 'Those are not your rules' }), { status: 400 })
					: realFetch(url, init)
			)
		);
		await arrow(ruleHandle('B'), 'up');
		await waitFor(() => expect(within(allRules()).getByRole('alert').textContent).toBe('Those are not your rules'));
		expect(listed()).toEqual(['A', 'B']);
	});

	it('has nothing to drag when there is one rule', async () => {
		page([exact]);
		await openAllRules();
		expect((ruleHandle('Receipts') as HTMLButtonElement).disabled).toBe(true);
	});

	// was: moves a rule past the next rule that runs, a split rule’s second half included
	it('moves a rule past the next rule that runs, a split rule’s second half included', async () => {
		const a = base('a', 'A', { target: { kind: 'label', mailboxId: 'WORK' } });
		const a2 = base('a~2', 'A too', { target: { kind: 'folder', mailboxId: 'RCPT' }, stop: true, attention: 'split', note: { splitInto: 2 } });
		page([a, a2, base('b', 'B')]);
		await openAllRules();
		await arrow(ruleHandle('B'), 'up');
		await waitFor(() => expect(writes()).toHaveLength(1));
		expect(writes()[0].body).toEqual({ ids: ['a', 'b', 'a~2'] });
	});

	// was: moves past a rule waiting under "Needs your attention", leaving it where it is
	it('moves past a rule waiting under "Needs your attention", leaving it where it is', async () => {
		const f = { ...flagged, id: 'f' };
		page([base('a', 'A'), f, base('b', 'B')]);
		await openAllRules();
		expect(within(attentionList()).queryByRole('button', { name: /Reorder|Move/ })).toBeNull();
		expect(attentionList().querySelector('[data-sort-id], [data-sort-handle]')).toBeNull();
		expect(within(allRules()).queryByText('Invoices')).toBeNull();
		// A is the first of the rules listed: up sends nothing.
		await arrow(ruleHandle('A'), 'up');
		await settle();
		expect(writes()).toEqual([]);
		await arrow(ruleHandle('B'), 'up');
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
	it('moves nothing more while a change is being saved, with the handles still there to focus', async () => {
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
		const reorders = () => server.calls.filter((c) => c.url === '/api/rules/reorder');
		await arrow(ruleHandle('B'), 'up');
		await waitFor(() => expect((ruleRow('C').getByRole('switch') as HTMLButtonElement).disabled).toBe(true));
		// The handles are not switched off: one that is loses the focus, and
		// the key that moved the row couldn't be pressed again.
		expect((ruleHandle('C') as HTMLButtonElement).disabled).toBe(false);
		expect((ruleHandle('B') as HTMLButtonElement).disabled).toBe(false);
		// Neither the keys nor a drag move anything meanwhile.
		await fireEvent.keyDown(ruleHandle('C'), { key: 'ArrowUp' });
		await drag('All rules, in order', 'C', 'A', 0.25);
		expect(document.querySelector('.sort-ghost')).toBeNull();
		release();
		await waitFor(() => expect((ruleRow('C').getByRole('switch') as HTMLButtonElement).disabled).toBe(false));
		expect(listed()).toEqual(['B', 'A', 'C']);
		expect(reorders()).toHaveLength(1);
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
		expect(within(dialog()).getByRole('link', { name: 'Settings → Inbox tabs → Pinned senders' }).getAttribute('href')).toBe(
			'/settings/inbox-tabs#pinned-senders'
		);
	});
});

describe('Folders & labels: folders and labels with their rules', () => {
	it('shows the folders as a tree, the labels as a list, and the system folders apart', async () => {
		page([]);
		expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Folders & labels');
		const folders = within(region('Folders'));
		expect(folders.getAllByRole('group').map((g) => g.getAttribute('aria-label'))).toEqual(['Receipts', 'Projects', 'Clients']);
		const indent = (name: string) => folders.getByRole('group', { name }).style.getPropertyValue('--indent');
		expect([indent('Receipts'), indent('Projects'), indent('Clients')]).toEqual(['0px', '0px', '24px']);

		const labelRows = within(region('Labels')).getAllByRole('group').map((g) => g.getAttribute('aria-label'));
		expect(labelRows).toEqual(['Work', 'Home']);

		// Folded until asked for.
		const fold = screen.getByRole('button', { name: 'System folders' });
		expect(fold.closest('h2')?.id).toBe('system-heading');
		expect(fold.getAttribute('aria-expanded')).toBe('false');
		expect(within(region('System folders')).queryByRole('group')).toBeNull();
		await fireEvent.click(fold);
		expect(fold.getAttribute('aria-expanded')).toBe('true');
		const system = within(region('System folders')).getAllByRole('group').map((g) => g.getAttribute('aria-label'));
		expect(system).toEqual(['Inbox', 'Sent', 'Trash']);
		// Not editable or movable, and only Trash of these can be filed into.
		expect(within(region('System folders')).queryByRole('button', { name: /Edit|Delete|Reorder|options/ })).toBeNull();
		expect(region('System folders').querySelector('[data-sort-id], [data-sort-handle], [aria-haspopup]')).toBeNull();
		expect(rowOpener('System folders', 'Inbox')).toBeNull();
		expect(rowOpener('System folders', 'Trash')?.getAttribute('aria-expanded')).toBe('false');
		// The name says which it is: its role isn't spelled out beside it.
		expect(mailboxGroup('System folders', 'Trash').textContent?.trim()).toBe('Trash');
		await fireEvent.click(fold);
		expect(within(region('System folders')).queryByRole('group')).toBeNull();
	});

	it('names its sections, and what links elsewhere land on', () => {
		page([flagged]);
		for (const [name, id] of [
			['Needs your attention', 'attention'],
			['Folders', 'folders'],
			['Labels', 'labels'],
			['All rules, in order', 'rules'],
			['System folders', 'system']
		]) {
			expect(region(name).id).toBe(id);
			expect(region(name).getAttribute('aria-labelledby')).toBe(`${id}-heading`);
			expect(document.getElementById(`${id}-heading`)?.tagName).toBe('H2');
		}
		expect(within(attentionList()).getByText('An upgrade switched these rules off.')).toBeTruthy();
	});

	it('says so when there are no folders, labels or rules', async () => {
		stubFetch([]);
		render(Page, { props: { data: { rules: [], labels: [], mailboxes: mailboxes.filter((m) => m.role), mailboxMeta: {} } } as never });
		expect(within(region('Folders')).getByText('No folders')).toBeTruthy();
		expect(within(region('Labels')).getByText('No labels')).toBeTruthy();
		expect(document.querySelector('[data-sort-id]')).toBeNull();
		await openAllRules();
		expect(within(allRules()).getByText('No rules')).toBeTruthy();
		expect(within(allRules()).getByText('Top first. Labels add up; the first rule that moves a message decides its folder.')).toBeTruthy();
	});

	it('says how many rules file into a folder or label, and nothing else beside its name', () => {
		page([exact, base('r2', 'More receipts', { target: { kind: 'folder', mailboxId: 'RCPT' } }), splitRow]);
		expect(mailboxRow('Folders', 'Receipts').getByText('2 rules')).toBeTruthy();
		expect(mailboxRow('Labels', 'Work').getByText('1 rule')).toBeTruthy();
		expect(mailboxRow('Labels', 'Home').queryByText(/rule/)).toBeNull();
		// Receipts has two unread: not said here, so nothing to set the count apart from.
		expect(rowOpener('Folders', 'Receipts')?.textContent?.replace(/\s+/g, ' ').trim()).toBe('Receipts 2 rules');
		expect(document.body.textContent).not.toContain('unread');
		expect(document.body.textContent).not.toContain('·');
	});

	it('gives each folder and label a handle and one menu, and no Move, Edit or Delete buttons of its own', () => {
		page([]);
		for (const [section, names] of [
			['Folders', ['Receipts', 'Projects', 'Clients']],
			['Labels', ['Work', 'Home']]
		] as const) {
			for (const name of names) {
				const grip = handle(section, name);
				expect(grip.hasAttribute('data-sort-handle')).toBe(true);
				expect(grip.closest('[data-sort-id]')?.parentElement).toBe(mailboxGroup(section, name));
				const options = optionsButton(section, name);
				expect(options.getAttribute('aria-haspopup')).toBe('menu');
				expect(options.getAttribute('aria-expanded')).toBe('false');
			}
			expect(sortRows(section).map((row) => row.dataset.sortId)).toEqual(
				section === 'Folders' ? ['RCPT', 'PRJ', 'CLI'] : ['WORK', 'HOME']
			);
			expect(within(region(section)).queryByRole('button', { name: /^(Move|Edit|Delete|View) / })).toBeNull();
			expect(within(region(section)).queryByRole('link')).toBeNull();
		}
		expect(screen.queryByRole('menu')).toBeNull();
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
		expect(mailboxRow('Labels', 'Home').getByText('No rules')).toBeTruthy();
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
		await openSystemFolders();
		for (const section of ['Folders', 'Labels', 'System folders']) {
			const groups = within(region(section)).getAllByRole('group');
			for (const group of groups) await fireEvent.click(rowOpener(section, group.getAttribute('aria-label')!) ?? group);
		}
		// Every row that can hold rules is open: Receipts, Projects, Clients, Work, Home and Trash.
		expect(screen.getAllByRole('button', { name: 'Add rule' })).toHaveLength(6);
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
		await choose('Folders', 'Receipts', 'Edit');
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
		await choose('Labels', 'Work', 'Edit');
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
		await choose('Folders', 'Receipts', 'Delete');
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
		await choose('Labels', 'Work', 'Delete');
		expect(asked).toHaveBeenCalledWith('Delete "Work"? Emails tagged with this label will not be deleted. This also deletes 1 rule that files into it.');
		await waitFor(() => expect(folderCalls()).toEqual([{ method: 'POST', url: '/api/folders', body: { action: 'delete', id: 'WORK' } }]));

		asked.mockClear();
		server.calls = [];
		await choose('Labels', 'Home', 'Delete');
		expect(asked).toHaveBeenCalledWith('Delete "Home"? Emails tagged with this label will not be deleted.');
	});

	it('sends nothing when a delete is called off', async () => {
		vi.stubGlobal('confirm', () => false);
		page([]);
		await choose('Folders', 'Receipts', 'Delete');
		await new Promise((r) => setTimeout(r, 10));
		expect(folderCalls()).toEqual([]);
	});

	it('goes to the Inbox when the folder being viewed is deleted', async () => {
		vi.stubGlobal('confirm', () => true);
		app.page.url = new URL('http://localhost/folder/PRJ');
		page([]);
		await choose('Folders', 'Receipts', 'Delete');
		await waitFor(() => expect(nav.invalidateAll).toHaveBeenCalled());
		expect(nav.goto).not.toHaveBeenCalled();
		await choose('Folders', 'Projects', 'Delete');
		await waitFor(() => expect(nav.goto).toHaveBeenCalledWith('/inbox'));
	});

	it('moves a folder and a label one place up or down among their neighbours', async () => {
		page([]);
		// The first has nowhere to go up, nor the last of its level down: nothing is sent.
		await arrow(handle('Folders', 'Receipts'), 'up');
		await arrow(handle('Folders', 'Projects'), 'down');
		await arrow(handle('Folders', 'Clients'), 'up');
		await arrow(handle('Folders', 'Clients'), 'down');
		await arrow(handle('Labels', 'Work'), 'up');
		await arrow(handle('Labels', 'Home'), 'down');
		await settle();
		expect(server.calls).toEqual([]);
		expect(nav.invalidateAll).not.toHaveBeenCalled();

		await arrow(handle('Folders', 'Receipts'), 'down');
		await waitFor(() =>
			expect(folderCalls()).toEqual([{ method: 'POST', url: '/api/folders', body: { action: 'reorder', id: 'RCPT', parentId: null, beforeId: null } }])
		);
		await waitFor(() => expect(nav.invalidateAll).toHaveBeenCalledTimes(1));
		await settle();
		server.calls = [];
		await arrow(handle('Labels', 'Home'), 'up');
		await waitFor(() =>
			expect(folderCalls()).toEqual([{ method: 'POST', url: '/api/folders', body: { action: 'reorder', id: 'HOME', parentId: 'LBLS', beforeId: 'WORK' } }])
		);
		await waitFor(() => expect(nav.invalidateAll).toHaveBeenCalledTimes(2));
		await settle();
		server.calls = [];
		await arrow(handle('Folders', 'Projects'), 'up');
		await waitFor(() =>
			expect(folderCalls()).toEqual([{ method: 'POST', url: '/api/folders', body: { action: 'reorder', id: 'PRJ', parentId: null, beforeId: 'RCPT' } }])
		);
	});

	it('moves a folder by dragging it before or after another', async () => {
		page([]);
		// Onto the top quarter of Receipts: before it.
		await drag('Folders', 'Projects', 'Receipts', 0.1);
		await waitFor(() =>
			expect(folderCalls()).toEqual([{ method: 'POST', url: '/api/folders', body: { action: 'reorder', id: 'PRJ', parentId: null, beforeId: 'RCPT' } }])
		);
		await waitFor(() => expect(nav.invalidateAll).toHaveBeenCalledTimes(1));
		expect(document.querySelector('.sort-ghost, [data-sort-dragging], [data-sort-drop]')).toBeNull();
		await settle();

		// Onto the bottom quarter of Projects: after it, which is last.
		server.calls = [];
		await drag('Folders', 'Receipts', 'Projects', 0.9);
		await waitFor(() =>
			expect(folderCalls()).toEqual([{ method: 'POST', url: '/api/folders', body: { action: 'reorder', id: 'RCPT', parentId: null, beforeId: null } }])
		);
		await waitFor(() => expect(nav.invalidateAll).toHaveBeenCalledTimes(2));
		await settle();

		// Beside a folder inside another: into that one, at that place.
		server.calls = [];
		await drag('Folders', 'Receipts', 'Clients', 0.1);
		await waitFor(() =>
			expect(folderCalls()).toEqual([{ method: 'POST', url: '/api/folders', body: { action: 'reorder', id: 'RCPT', parentId: 'PRJ', beforeId: 'CLI' } }])
		);
	});

	it('puts a folder inside another when it is let go on its middle', async () => {
		page([]);
		await carry('Folders', 'Receipts', 'Projects', 0.5);
		expect(sortRow('Folders', 'Receipts').hasAttribute('data-sort-dragging')).toBe(true);
		expect(sortRow('Folders', 'Projects').getAttribute('data-sort-drop')).toBe('into');
		expect(writes()).toEqual([]);
		await fireEvent.pointerUp(window, { pointerId: 1, clientX: 10, clientY: 60 });
		await waitFor(() =>
			expect(folderCalls()).toEqual([{ method: 'POST', url: '/api/folders', body: { action: 'reorder', id: 'RCPT', parentId: 'PRJ', beforeId: null } }])
		);
		await waitFor(() => expect(nav.invalidateAll).toHaveBeenCalledTimes(1));
		expect(document.querySelector('.sort-ghost, [data-sort-dragging], [data-sort-drop]')).toBeNull();
		await settle();

		// A folder already inside one goes into another the same way.
		server.calls = [];
		await drag('Folders', 'Clients', 'Receipts', 0.5);
		await waitFor(() =>
			expect(folderCalls()).toEqual([{ method: 'POST', url: '/api/folders', body: { action: 'reorder', id: 'CLI', parentId: 'RCPT', beforeId: null } }])
		);
	});

	it('takes a folder out of another when it is dragged beside a top-level one', async () => {
		page([]);
		await drag('Folders', 'Clients', 'Receipts', 0.1);
		await waitFor(() =>
			expect(folderCalls()).toEqual([{ method: 'POST', url: '/api/folders', body: { action: 'reorder', id: 'CLI', parentId: null, beforeId: 'RCPT' } }])
		);
	});

	it('puts a folder last at the top level when it is let go under the whole list', async () => {
		// The last row is Clients, inside Projects: under the list is not
		// "inside Projects".
		page([]);
		await drag('Folders', 'Receipts', 'Clients', 2);
		await waitFor(() =>
			expect(folderCalls()).toEqual([{ method: 'POST', url: '/api/folders', body: { action: 'reorder', id: 'RCPT', parentId: null, beforeId: null } }])
		);
		await waitFor(() => expect(nav.invalidateAll).toHaveBeenCalledTimes(1));
		await settle();

		// The same takes a nested folder out to the top level.
		server.calls = [];
		await drag('Folders', 'Clients', 'Clients', 2);
		await waitFor(() =>
			expect(folderCalls()).toEqual([{ method: 'POST', url: '/api/folders', body: { action: 'reorder', id: 'CLI', parentId: null, beforeId: null } }])
		);
		await settle();

		// A folder that is last at the top level already stays where it is.
		server.calls = [];
		await drag('Folders', 'Projects', 'Clients', 2);
		await settle();
		expect(folderCalls()).toEqual([]);
	});

	it('will not put a folder inside itself or one of its own', async () => {
		page([]);
		for (const ratio of [0.1, 0.5, 0.9]) {
			await carry('Folders', 'Projects', 'Clients', ratio);
			// Carried, with nowhere marked to land.
			expect(document.querySelector('.sort-ghost')).toBeTruthy();
			expect(document.querySelector('[data-sort-drop]')).toBeNull();
			await fireEvent.pointerUp(window, { pointerId: 1, clientX: 10, clientY: 100 });
		}
		await settle();
		expect(server.calls).toEqual([]);
		expect(nav.invalidateAll).not.toHaveBeenCalled();
		expect(document.querySelector('.sort-ghost, [data-sort-dragging]')).toBeNull();
	});

	it('moves a label by dragging it before or after another, never inside it', async () => {
		page([]);
		// The middle of a label is not a place of its own: its halves are before and after.
		await carry('Labels', 'Home', 'Work', 0.4);
		expect(sortRow('Labels', 'Work').getAttribute('data-sort-drop')).toBe('before');
		await fireEvent.pointerUp(window, { pointerId: 1, clientX: 10, clientY: 16 });
		await waitFor(() =>
			expect(folderCalls()).toEqual([{ method: 'POST', url: '/api/folders', body: { action: 'reorder', id: 'HOME', parentId: 'LBLS', beforeId: 'WORK' } }])
		);
		await waitFor(() => expect(nav.invalidateAll).toHaveBeenCalledTimes(1));
		await settle();

		server.calls = [];
		await carry('Labels', 'Work', 'Home', 0.6);
		expect(sortRow('Labels', 'Home').getAttribute('data-sort-drop')).toBe('after');
		await fireEvent.pointerUp(window, { pointerId: 1, clientX: 10, clientY: 64 });
		await waitFor(() =>
			expect(folderCalls()).toEqual([{ method: 'POST', url: '/api/folders', body: { action: 'reorder', id: 'WORK', parentId: 'LBLS', beforeId: null } }])
		);
	});

	it('opens the folder from View in its menu', async () => {
		page([]);
		await choose('Folders', 'Clients', 'View');
		expect(nav.goto).toHaveBeenCalledWith('/folder/CLI');
		await choose('Labels', 'Home', 'View');
		expect(nav.goto).toHaveBeenLastCalledWith('/folder/HOME');
		expect(writes()).toEqual([]);
		expect(screen.queryByRole('menu')).toBeNull();
	});

	it('offers View, Edit and Delete in a row’s menu, and closes it on Escape with focus back on its button', async () => {
		const asked = vi.fn(() => false);
		vi.stubGlobal('confirm', asked);
		page([]);
		const options = optionsButton('Folders', 'Receipts');
		await fireEvent.click(options);
		expect(options.getAttribute('aria-expanded')).toBe('true');
		const list = menu('Receipts');
		expect(list.parentElement).toBe(document.body);
		const items = within(list).getAllByRole('menuitem');
		expect(items.map((item) => item.textContent?.trim())).toEqual(['View', 'Edit', 'Delete']);
		await waitFor(() => expect(document.activeElement).toBe(items[0]));

		// The arrows walk the menu, round and round; they move no folder.
		await fireEvent.keyDown(items[0], { key: 'ArrowDown' });
		expect(document.activeElement).toBe(items[1]);
		await fireEvent.keyDown(items[1], { key: 'ArrowUp' });
		await fireEvent.keyDown(items[0], { key: 'ArrowUp' });
		expect(document.activeElement).toBe(items[2]);

		await fireEvent.keyDown(items[2], { key: 'Escape' });
		expect(screen.queryByRole('menu')).toBeNull();
		expect(options.getAttribute('aria-expanded')).toBe('false');
		expect(document.activeElement).toBe(options);
		expect(asked).not.toHaveBeenCalled();
		expect(server.calls).toEqual([]);
		expect(nav.goto).not.toHaveBeenCalled();

		// One menu at a time: a press elsewhere closes it.
		await fireEvent.click(options);
		await fireEvent.pointerDown(document.body);
		expect(screen.queryByRole('menu')).toBeNull();
	});

	it('closes the menu once something is chosen from it, with focus back on its button', async () => {
		vi.stubGlobal('confirm', () => false);
		page([]);
		await choose('Folders', 'Receipts', 'Delete');
		expect(screen.queryByRole('menu')).toBeNull();
		expect(optionsButton('Folders', 'Receipts').getAttribute('aria-expanded')).toBe('false');
		expect(document.activeElement).toBe(optionsButton('Folders', 'Receipts'));
		await choose('Labels', 'Home', 'View');
		expect(screen.queryByRole('menu')).toBeNull();
		expect(document.activeElement).toBe(optionsButton('Labels', 'Home'));
	});

	it('shows what the server refused in the page, never in an alert', async () => {
		const alert = vi.fn();
		vi.stubGlobal('alert', alert);
		vi.stubGlobal('confirm', () => true);
		page([]);
		server.folderError = 'Remove labels inside this folder first';
		await choose('Folders', 'Receipts', 'Delete');
		await waitFor(() => expect(within(region('Folders')).getByRole('alert').textContent).toBe('Remove labels inside this folder first'));

		server.folderError = 'Labels stay under Labels';
		await arrow(handle('Labels', 'Home'), 'up');
		await waitFor(() => expect(within(region('Labels')).getByRole('alert').textContent).toBe('Labels stay under Labels'));
		await settle();

		// A drag that is refused says so in the same place, and the next change clears it.
		server.folderError = 'That folder is not at the destination';
		await drag('Folders', 'Receipts', 'Projects', 0.5);
		await waitFor(() => expect(within(region('Folders')).getByRole('alert').textContent).toBe('That folder is not at the destination'));
		expect(nav.invalidateAll).not.toHaveBeenCalled();
		expect(alert).not.toHaveBeenCalled();
		await settle();

		server.folderError = null;
		await drag('Folders', 'Receipts', 'Projects', 0.5);
		await waitFor(() => expect(nav.invalidateAll).toHaveBeenCalled());
		expect(within(region('Folders')).queryByRole('alert')).toBeNull();
		expect(within(region('Labels')).getByRole('alert').textContent).toBe('Labels stay under Labels');
	});

	it('says the move failed when the server gives no reason', async () => {
		page([]);
		const realFetch = globalThis.fetch;
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string, init?: RequestInit) => (url === '/api/folders' ? Promise.reject(new Error('offline')) : realFetch(url, init)))
		);
		await arrow(handle('Folders', 'Receipts'), 'down');
		await waitFor(() => expect(within(region('Folders')).getByRole('alert').textContent).toBe('The folder couldn’t be moved. Try again.'));
		await settle();
		await drag('Labels', 'Home', 'Work', 0.2);
		await waitFor(() => expect(within(region('Labels')).getByRole('alert').textContent).toBe('The label couldn’t be moved. Try again.'));
		expect(nav.invalidateAll).not.toHaveBeenCalled();
	});
});

/** Hold back the requests `match` picks until the returned function is called. */
function hold(match: (url: string, init?: RequestInit) => boolean): (() => void) & { reached: () => boolean } {
	let release: (() => void) | undefined;
	let reached = false;
	const gate = new Promise<void>((r) => (release = r));
	const realFetch = globalThis.fetch;
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string, init?: RequestInit) => {
			if (match(url, init)) {
				reached = true;
				await gate;
			}
			return realFetch(url, init);
		})
	);
	return Object.assign(() => release?.(), { reached: () => reached });
}
const backdrop = () => dialog().parentElement as HTMLElement;
const typeRule = async () => {
	await fireEvent.input(within(dialog()).getByLabelText('Name'), { target: { value: 'Boss mail' } });
	await fireEvent.input(within(dialog()).getByLabelText('Value'), { target: { value: 'boss@' } });
};
const addRuleTo = async (section: string, row: string) => {
	await openRow(section, row);
	await fireEvent.click(mailboxRow(section, row).getByRole('button', { name: 'Add rule' }));
};

describe('Folders & labels: a label is shown by its name', () => {
	it('names a label by its name, not its mailbox name, in its row, its handle, its menu and its delete question', async () => {
		const asked = vi.fn(() => false);
		vi.stubGlobal('confirm', asked);
		stubFetch([]);
		render(Page, {
			props: {
				data: {
					rules: [],
					labels: labels.map((l) => (l.id === 'HOME' ? { ...l, name: 'Home Stuff' } : l)),
					mailboxes: mailboxes.map((m) => (m.id === 'HOME' ? { ...m, name: 'home-stuff' } : m)),
					mailboxMeta: {}
				}
			} as never
		});
		expect(within(region('Labels')).getAllByRole('group').map((g) => g.getAttribute('aria-label'))).toEqual(['Work', 'Home Stuff']);
		const row = mailboxRow('Labels', 'Home Stuff');
		expect(row.getByText('Home Stuff')).toBeTruthy();
		for (const name of ['Reorder Home Stuff', 'Home Stuff options']) {
			expect(row.getByRole('button', { name })).toBeTruthy();
		}
		await openRow('Labels', 'Home Stuff');
		await fireEvent.click(optionsButton('Labels', 'Home Stuff'));
		expect(menu('Home Stuff')).toBeTruthy();
		expect(document.body.innerHTML).not.toContain('home-stuff');
		await fireEvent.click(within(menu('Home Stuff')).getByRole('menuitem', { name: 'Delete' }));
		expect(asked).toHaveBeenCalledWith('Delete "Home Stuff"? Emails tagged with this label will not be deleted.');
		expect(document.body.innerHTML).not.toContain('home-stuff');
	});
});

describe('Folders & labels: a half-written rule is kept', () => {
	it('asks before Escape or the X throws a changed rule away, keeps it on "no", and ignores a click outside', async () => {
		const asked = vi.fn(() => false);
		vi.stubGlobal('confirm', asked);
		page([]);
		await addRuleTo('Folders', 'Projects');
		await typeRule();

		await fireEvent.keyDown(dialog(), { key: 'Escape' });
		expect(asked).toHaveBeenCalledWith('Discard your changes to this rule?');
		await fireEvent.click(within(dialog()).getByRole('button', { name: 'Close' }));
		expect(asked).toHaveBeenCalledTimes(2);
		await fireEvent.click(backdrop());
		expect(asked).toHaveBeenCalledTimes(2);
		expect((within(dialog()).getByLabelText('Name') as HTMLInputElement).value).toBe('Boss mail');
		expect((within(dialog()).getByLabelText('Value') as HTMLInputElement).value).toBe('boss@');

		asked.mockReturnValue(true);
		await fireEvent.keyDown(dialog(), { key: 'Escape' });
		expect(screen.queryByRole('dialog')).toBeNull();
		expect(writes()).toEqual([]);
	});

	it('closes an unchanged rule at once on Escape, a click outside or the X', async () => {
		const asked = vi.fn(() => false);
		vi.stubGlobal('confirm', asked);
		page([exact]);
		await openRow('Folders', 'Receipts');
		const line = () => mailboxRow('Folders', 'Receipts').getByText('From contains “shop.example”');
		await fireEvent.click(line());
		await fireEvent.keyDown(dialog(), { key: 'Escape' });
		expect(screen.queryByRole('dialog')).toBeNull();
		await fireEvent.click(line());
		await fireEvent.click(backdrop());
		expect(screen.queryByRole('dialog')).toBeNull();
		await fireEvent.click(line());
		await fireEvent.click(within(dialog()).getByRole('button', { name: 'Close' }));
		expect(screen.queryByRole('dialog')).toBeNull();
		await fireEvent.click(mailboxRow('Folders', 'Receipts').getByRole('button', { name: 'Add rule' }));
		await fireEvent.keyDown(dialog(), { key: 'Escape' });
		expect(screen.queryByRole('dialog')).toBeNull();
		expect(asked).not.toHaveBeenCalled();
	});

	it('closes a changed rule on Cancel without asking', async () => {
		const asked = vi.fn(() => false);
		vi.stubGlobal('confirm', asked);
		page([]);
		await addRuleTo('Folders', 'Projects');
		await typeRule();
		await fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
		expect(screen.queryByRole('dialog')).toBeNull();
		expect(asked).not.toHaveBeenCalled();
	});

	it('cannot be closed while its save is on its way, and applies only once it has saved', async () => {
		const asked = vi.fn(() => true);
		vi.stubGlobal('confirm', asked);
		page([exact]);
		await openFromList('Receipts');
		const release = hold((url, init) => init?.method === 'PATCH');
		await fireEvent.click(within(dialog()).getByRole('button', { name: 'Save & apply' }));
		await waitFor(() => expect(within(dialog()).getByRole('button', { name: 'Saving…' })).toBeTruthy());

		await fireEvent.keyDown(dialog(), { key: 'Escape' });
		await fireEvent.click(within(dialog()).getByRole('button', { name: 'Close' }));
		await fireEvent.click(backdrop());
		expect(screen.getByRole('dialog', { name: 'Receipts' })).toBeTruthy();
		expect(asked).not.toHaveBeenCalled();
		await new Promise((r) => setTimeout(r, 20));
		expect(server.calls.some((c) => c.url === '/api/rules/apply')).toBe(false);

		release();
		await waitFor(() => expect(writes().map((c) => c.url)).toEqual(['/api/rules/exact', '/api/rules/apply']));
		expect(screen.queryByRole('dialog', { name: 'Receipts' })).toBeNull();
	});
});

describe('Folders & labels: a save ends in its dialog', () => {
	it('stays open while the saved rule is read back, and only then applies it', async () => {
		vi.stubGlobal('confirm', () => true);
		page([exact]);
		await openFromList('Receipts');
		await fireEvent.input(within(dialog()).getByLabelText('Name'), { target: { value: 'Renamed' } });
		const release = hold((url, init) => url === '/api/rules' && (init?.method ?? 'GET') === 'GET');
		await fireEvent.click(within(dialog()).getByRole('button', { name: 'Save & apply' }));
		await waitFor(() => expect(release.reached()).toBe(true));
		await fireEvent.keyDown(dialog(), { key: 'Escape' });
		expect(screen.getByRole('dialog', { name: 'Receipts' })).toBeTruthy();
		release();
		await waitFor(() => expect(writes().map((c) => c.url)).toEqual(['/api/rules/exact', '/api/rules/apply']));
	});
});

describe('Folders & labels: notes on a rule where the rule is', () => {
	it('shows a running rule’s note and "Got it" in its row, and clears it there and under "All rules"', async () => {
		page([{ ...tabRemoved, target: { kind: 'label', mailboxId: 'WORK' } }]);
		await openRow('Labels', 'Work');
		await openAllRules();
		const note = 'No longer puts mail in the Newsletters tab.';
		expect(mailboxRow('Labels', 'Work').getByText(note)).toBeTruthy();
		expect(ruleRow('Work mail').getByText(note)).toBeTruthy();
		await fireEvent.click(mailboxRow('Labels', 'Work').getByRole('button', { name: 'Got it' }));
		await waitFor(() => expect(writes()).toEqual([{ method: 'POST', url: '/api/rules/tab-removed/dismiss', body: undefined }]));
		await waitFor(() => expect(screen.queryByText(note)).toBeNull());
		expect(screen.queryByRole('button', { name: 'Got it' })).toBeNull();
	});

	it('has its own "Got it" in the dialog for a rule that lost its tab or was split', async () => {
		page([{ ...tabRemoved, target: { kind: 'label', mailboxId: 'WORK' } }, splitRow]);
		await openRow('Labels', 'Work');
		await fireEvent.click(mailboxRow('Labels', 'Work').getByText('Work mail'));
		expect(within(dialog()).queryByText(/in the list/)).toBeNull();
		await fireEvent.click(within(dialog()).getByRole('button', { name: 'Got it' }));
		await waitFor(() => expect(writes()).toEqual([{ method: 'POST', url: '/api/rules/tab-removed/dismiss', body: undefined }]));
		await waitFor(() => expect(within(dialog()).queryByText('This rule no longer puts mail in the Newsletters tab.')).toBeNull());
		expect(mailboxRow('Labels', 'Work').queryByText('No longer puts mail in the Newsletters tab.')).toBeNull();
		await fireEvent.click(within(dialog()).getByRole('button', { name: 'Close' }));

		server.calls = [];
		await fireEvent.click(mailboxRow('Labels', 'Work').getByText('Shop'));
		expect(within(dialog()).queryByText(/in the list/)).toBeNull();
		await fireEvent.click(within(dialog()).getByRole('button', { name: 'Got it' }));
		await waitFor(() => expect(writes()).toEqual([{ method: 'POST', url: '/api/rules/split~2/dismiss', body: undefined }]));
	});
});

describe('Folders & labels: focus in and out of the dialogs', () => {
	it('keeps Tab inside the rule dialog', async () => {
		page([]);
		await addRuleTo('Folders', 'Projects');
		const close = within(dialog()).getByRole('button', { name: 'Close' });
		const last = within(dialog()).getByRole('button', { name: 'Save & apply' });
		expect(document.activeElement).toBe(dialog());
		await fireEvent.keyDown(dialog(), { key: 'Tab', shiftKey: true });
		expect(document.activeElement).toBe(last);
		await fireEvent.keyDown(last, { key: 'Tab' });
		expect(document.activeElement).toBe(close);
		await fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
		expect(document.activeElement).toBe(last);
	});

	it('keeps Tab inside the apply progress', async () => {
		page([exact]);
		hold((url) => url === '/api/rules/apply');
		await openFromList('Receipts');
		await fireEvent.click(within(dialog()).getByRole('button', { name: 'Save & apply' }));
		await waitFor(() => expect(screen.getByRole('heading', { name: 'Applying rule…' })).toBeTruthy());
		const progress = screen.getByRole('dialog');
		expect(document.activeElement).toBe(progress);
		const background = within(progress).getByRole('button', { name: 'Run in background' });
		const cancel = within(progress).getByRole('button', { name: 'Cancel' });
		cancel.focus();
		await fireEvent.keyDown(cancel, { key: 'Tab' });
		expect(document.activeElement).toBe(background);
		await fireEvent.keyDown(background, { key: 'Tab', shiftKey: true });
		expect(document.activeElement).toBe(cancel);
	});

	it('gives focus back to what opened the dialog after Cancel and Save', async () => {
		page([exact]);
		await openRow('Folders', 'Receipts');
		const add = mailboxRow('Folders', 'Receipts').getByRole('button', { name: 'Add rule' });
		await fireEvent.click(add);
		await fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
		await waitFor(() => expect(document.activeElement).toBe(add));

		const line = mailboxRow('Folders', 'Receipts').getByText('From contains “shop.example”').closest('button') as HTMLElement;
		await fireEvent.click(line);
		await fireEvent.input(within(dialog()).getByLabelText('Name'), { target: { value: 'Renamed' } });
		await fireEvent.click(within(dialog()).getByRole('button', { name: 'Save' }));
		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
		await waitFor(() => expect(document.activeElement).toBe(line));
		expect(line.isConnected).toBe(true);

		await openAllRules();
		const newRule = within(allRules()).getByRole('button', { name: 'New rule' });
		await fireEvent.click(newRule);
		await fireEvent.keyDown(dialog(), { key: 'Escape' });
		await waitFor(() => expect(document.activeElement).toBe(newRule));
	});

	it('gives focus to the row, or the section heading, when the rule that opened the dialog was deleted', async () => {
		vi.stubGlobal('confirm', () => true);
		page([exact, base('other', 'Other')]);
		await openRow('Folders', 'Receipts');
		await fireEvent.click(mailboxRow('Folders', 'Receipts').getByText('From contains “shop.example”'));
		await fireEvent.click(within(dialog()).getByRole('button', { name: 'Delete' }));
		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
		await waitFor(() => expect(document.activeElement).toBe(within(region('Folders')).getByRole('group', { name: 'Receipts' })));

		await openFromList('Other');
		await fireEvent.click(within(dialog()).getByRole('button', { name: 'Delete' }));
		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
		await waitFor(() => expect(document.activeElement).toBe(document.getElementById('rules-heading')));
	});
});

describe('Folders & labels: rows on a phone', () => {
	it('keeps View, Edit and Delete in the row’s one menu at every width, with nothing more inside the opened row', async () => {
		const asked = vi.fn(() => false);
		vi.stubGlobal('confirm', asked);
		page([]);
		for (const [section, row] of [
			['Folders', 'Receipts'],
			['Labels', 'Work']
		] as const) {
			// Neither the handle nor the menu is hidden at any width.
			for (const button of [handle(section, row), optionsButton(section, row)]) {
				expect(button.className).not.toMatch(/(^|[\s:])hidden(\s|$)/);
				expect(button.closest('.md\\:hidden, .max-md\\:hidden, .hidden')).toBeNull();
			}
			await openRow(section, row);
			// Opened, the row holds its rules and "Add rule": nothing to edit or delete it by.
			expect(mailboxRow(section, row).getByRole('button', { name: 'Add rule' })).toBeTruthy();
			expect(mailboxRow(section, row).queryByRole('button', { name: /^(Edit|Delete)/ })).toBeNull();
			expect(mailboxGroup(section, row).querySelector('.md\\:hidden')).toBeNull();

			await fireEvent.click(optionsButton(section, row));
			const items = within(menu(row)).getAllByRole('menuitem') as HTMLButtonElement[];
			expect(items.map((item) => item.textContent?.trim())).toEqual(['View', 'Edit', 'Delete']);
			expect(items.map((item) => item.disabled)).toEqual([false, false, false]);
			await fireEvent.keyDown(items[0], { key: 'Escape' });
		}
		await choose('Labels', 'Work', 'Delete');
		expect(asked).toHaveBeenCalledWith('Delete "Work"? Emails tagged with this label will not be deleted.');
		await openRow('System folders', 'Trash');
		expect(within(region('System folders')).queryByRole('button', { name: /Edit|Delete|options/ })).toBeNull();
	});

	it('edits a folder from its menu while its row is open', async () => {
		Element.prototype.scrollTo = () => {};
		vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} });
		page([]);
		await openRow('Folders', 'Receipts');
		await choose('Folders', 'Receipts', 'Edit');
		expect((within(dialog()).getByLabelText('Folder name') as HTMLInputElement).value).toBe('Receipts');
		// Still open behind the dialog.
		expect(rowOpener('Folders', 'Receipts')?.getAttribute('aria-expanded')).toBe('true');
	});

	it('indents 24px a level, 14px on a phone and no deeper than four levels there', () => {
		const deep = [1, 2, 3, 4, 5, 6].map((n) => box(`L${n}`, `Level ${n}`, { parentId: n === 1 ? null : `L${n - 1}` }));
		stubFetch([]);
		render(Page, { props: { data: { rules: [], labels: [], mailboxes: [...mailboxes, ...deep], mailboxMeta: {} } } as never });
		const groups = deep.map((m) => within(region('Folders')).getByRole('group', { name: m.name }));
		expect(groups.map((g) => g.style.getPropertyValue('--indent'))).toEqual(['0px', '24px', '48px', '72px', '96px', '120px']);
		expect(groups.map((g) => g.style.getPropertyValue('--indent-sm'))).toEqual(['0px', '14px', '28px', '42px', '56px', '56px']);
		const classes = (groups[5].firstElementChild as HTMLElement).className.split(/\s+/);
		expect(classes).toContain('pl-[calc(0.5rem+var(--indent))]');
		expect(classes).toContain('max-md:pl-[calc(0.25rem+var(--indent-sm))]');
	});
});

describe('Folders & labels: the look of a row', () => {
	it('uses small switches for rules, in a row and under "All rules"', async () => {
		page([exact]);
		await openRow('Folders', 'Receipts');
		await openAllRules();
		for (const s of screen.getAllByRole('switch')) expect(s.className).toContain('w-7 h-4');
	});

	it('highlights a row on hover and keyboard focus only, not for being open', async () => {
		page([exact]);
		const opener = () => mailboxRow('Folders', 'Receipts').getByRole('button', { expanded: true });
		await openRow('Folders', 'Receipts');
		const classes = opener().className.split(/\s+/);
		expect(classes).toContain('hover:bg-surface-hover');
		expect(classes).toContain('focus-visible:bg-surface-hover');
		expect(classes.filter((c) => c.startsWith('bg-'))).toEqual([]);
	});
});

describe('Folders & labels: the page follows its data', () => {
	it('replaces the rules when the page’s data changes, keeping open rows open', async () => {
		const { rerender } = page([exact]);
		await openRow('Folders', 'Receipts');
		expect(mailboxRow('Folders', 'Receipts').getByText('From contains “shop.example”')).toBeTruthy();
		const other = base('o', 'Other account’s receipts', { target: { kind: 'folder', mailboxId: 'RCPT' }, conditions: [cond('co', 'from', 'other.example')] });
		await rerender({ data: { rules: [other], labels, mailboxes, mailboxMeta: {} } } as never);
		expect(mailboxRow('Folders', 'Receipts').getByRole('button', { expanded: true })).toBeTruthy();
		expect(mailboxRow('Folders', 'Receipts').getByText('Other account’s receipts')).toBeTruthy();
		expect(mailboxRow('Folders', 'Receipts').queryByText('From contains “shop.example”')).toBeNull();
	});
});

describe('Folders & labels: applying a rule and pending writes', () => {
	/** "Save & apply" on Receipts, with the apply request answered by `answer`. */
	async function saveAndApply(answer: (init: RequestInit) => Promise<Response>) {
		page([exact]);
		const realFetch = globalThis.fetch;
		const applies: RequestInit[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string, init?: RequestInit) => {
				if (url !== '/api/rules/apply') return realFetch(url, init);
				applies.push(init!);
				return answer(init!);
			})
		);
		await openFromList('Receipts');
		await fireEvent.click(within(dialog()).getByRole('button', { name: 'Save & apply' }));
		await waitFor(() => expect(applies).toHaveLength(1));
		return applies;
	}
	const sse = (body: string) => new Response(body);

	it('Cancel stops the apply request', async () => {
		const applies = await saveAndApply(
			(init) =>
				new Promise((_, reject) =>
					init.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
				)
		);
		expect(applies[0].signal!.aborted).toBe(false);
		await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
		expect(applies[0].signal!.aborted).toBe(true);
		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
	});

	it('"Run in background" closes the progress and lets the apply finish', async () => {
		let finish!: () => void;
		const applies = await saveAndApply(
			async () =>
				new Response(
					new ReadableStream({
						start(controller) {
							finish = () => {
								controller.enqueue(new TextEncoder().encode('data: {"type":"done","scanned":1,"matched":1,"applied":1,"failed":0}\n\n'));
								controller.close();
							};
						}
					})
				)
		);
		await fireEvent.click(screen.getByRole('button', { name: 'Run in background' }));
		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
		expect(applies[0].signal!.aborted).toBe(false);
		expect(nav.invalidateAll).not.toHaveBeenCalled();
		finish();
		await waitFor(() => expect(nav.invalidateAll).toHaveBeenCalled());
		expect(applies[0].signal!.aborted).toBe(false);
	});

	it('Retry after a failed apply sends it again', async () => {
		let first = true;
		const applies = await saveAndApply(async () => {
			if (first) {
				first = false;
				return new Response('nope', { status: 500 });
			}
			return sse('data: {"type":"done","scanned":1,"matched":1,"applied":1,"failed":0}\n\n');
		});
		await waitFor(() => expect(screen.getByRole('heading', { name: 'Failed' })).toBeTruthy());
		await fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
		await waitFor(() => expect(screen.getByRole('heading', { name: 'Applied' })).toBeTruthy());
		expect(applies).toHaveLength(2);
		expect(JSON.parse(String(applies[1].body))).toEqual({ ruleIds: ['exact'] });
	});

	it('disables the switches in a row while a change is being saved', async () => {
		page([exact, base('r2', 'More receipts', { target: { kind: 'folder', mailboxId: 'RCPT' } })]);
		await openRow('Folders', 'Receipts');
		const release = hold((url, init) => init?.method === 'PATCH');
		const switches = () => mailboxRow('Folders', 'Receipts').getAllByRole('switch') as HTMLButtonElement[];
		expect(switches().map((s) => s.disabled)).toEqual([false, false]);
		await fireEvent.click(switches()[0]);
		await waitFor(() => expect(switches().map((s) => s.disabled)).toEqual([true, true]));
		release();
		await waitFor(() => expect(switches().map((s) => s.disabled)).toEqual([false, false]));
	});
});
