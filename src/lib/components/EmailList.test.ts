// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { writable } from 'svelte/store';
import type { Email } from '$lib/jmap/types';
import type { InboxCategory } from '$lib/types/categories';

const mocks = vi.hoisted(() => ({
	page: {
		data: {
			activeAccountId: 'acct-1',
			mailboxes: [
				{ id: 'A', name: 'Projects', role: null, parentId: null, sortOrder: 0, totalEmails: 1, unreadEmails: 0 },
				{ id: 'TR', name: 'Trash', role: 'trash', parentId: null, sortOrder: 1, totalEmails: 1, unreadEmails: 0 }
			]
		},
		url: new URL('http://localhost/folder/A')
	}
}));

vi.mock('$app/state', () => ({ page: mocks.page }));
vi.mock('$app/navigation', () => ({ goto: vi.fn(), invalidateAll: vi.fn() }));
vi.mock('$app/environment', () => ({ browser: true, dev: false, building: false }));

import EmailList from './EmailList.svelte';

function email(id: string, sender: string, mailboxId: string): Email {
	return {
		id,
		blobId: `b-${id}`,
		threadId: `t-${id}`,
		mailboxIds: { [mailboxId]: true },
		keywords: { $seen: true },
		from: [{ name: sender, email: `${sender.toLowerCase()}@example.test` }],
		to: [{ name: null, email: 'me@example.test' }],
		cc: null,
		subject: `Hello from ${sender}`,
		receivedAt: '2026-10-20T10:00:00Z',
		size: 100,
		preview: '',
		hasAttachment: false
	} as Email;
}

const fetchMock = vi.fn(
	async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{}', { status: 200 })
);
const bulkBodies = () =>
	fetchMock.mock.calls
		.filter(([url]) => String(url) === '/api/email/bulk')
		.map(([, init]) => JSON.parse(String(init?.body)));

/** The list header, where the bulk actions are (rows have their own). */
const bulkBar = () => within(document.querySelector('header') as HTMLElement);

function renderList(props: { emails: Email[]; title: string; mailboxId: string }) {
	return render(EmailList, {
		props: { ...props, total: props.emails.length },
		context: new Map<string, unknown>([
			['labels', []],
			['readingPane', writable(false)]
		])
	});
}

beforeEach(() => {
	vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
	cleanup();
	fetchMock.mockClear();
	vi.unstubAllGlobals();
});

describe('EmailList selection', () => {
	it('is dropped when the list moves to another folder', async () => {
		const projects = email('a1', 'Dana', 'A');
		const trashed = email('t1', 'Omar', 'TR');
		const { rerender } = renderList({ emails: [projects], title: 'Projects', mailboxId: 'A' });

		await fireEvent.click(screen.getByLabelText('Select email from Dana'));
		expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();

		// What SvelteKit does on /folder/A → /folder/TR: same component, new props.
		await rerender({ emails: [trashed], total: 1, title: 'Trash', mailboxId: 'TR' });
		expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();

		// Pressing Trash in Trash destroys what is selected, so it must only
		// ever be what this list shows.
		await fireEvent.click(screen.getByLabelText('Select email from Omar'));
		await fireEvent.click(bulkBar().getByTitle('Trash'));
		expect(bulkBodies()).toEqual([{ ids: ['t1'], action: 'trash', sourceMailboxId: 'TR' }]);
	});

	it('loses rows that leave the list on a refresh, and keeps the rest', async () => {
		const a1 = email('a1', 'Dana', 'A');
		const a2 = email('a2', 'Omar', 'A');
		const { rerender } = renderList({ emails: [a1, a2], title: 'Projects', mailboxId: 'A' });

		await fireEvent.click(screen.getByLabelText('Select email from Dana'));
		await fireEvent.click(screen.getByLabelText('Select email from Omar'));

		// Another device moved a2 away; the list refreshes in place.
		await rerender({ emails: [a1], total: 1, title: 'Projects', mailboxId: 'A' });
		await fireEvent.click(bulkBar().getByTitle('Archive'));
		expect(bulkBodies()).toEqual([{ ids: ['a1'], action: 'archive', sourceMailboxId: 'A' }]);
	});
});

describe('EmailList switching Inbox tabs', () => {
	const unread = { important: 0, updates: 0, newsletters: 0, promotions: 0 };
	const inbox = (active: InboxCategory, emails: Email[], page = 1) => ({
		emails,
		total: 60,
		title: 'Inbox',
		mailboxId: 'A',
		page,
		pageSize: 25,
		totalPages: 3,
		inboxTabs: { active, unread }
	});

	function renderInbox(props: ReturnType<typeof inbox>) {
		return render(EmailList, {
			props,
			context: new Map<string, unknown>([
				['labels', []],
				['readingPane', writable(false)]
			])
		});
	}

	// The scroller under the tabs, and the column inside it that moves.
	const scroller = () =>
		document.querySelector('nav[aria-label="Inbox tabs"]')!.nextElementSibling as HTMLElement;
	const listBody = () => scroller().firstElementChild as HTMLElement;

	let animate: ReturnType<typeof vi.fn>;
	/** The keyframes the list's content was animated with, in order. */
	const listMotion = () =>
		animate.mock.calls
			.filter((_, i) => animate.mock.contexts[i] === listBody())
			.map(([keyframes]) => keyframes as Keyframe[]);
	const slides = () => listMotion().flatMap((k) => (k[0].transform ? [k[0].transform] : []));

	beforeEach(() => {
		animate = vi.fn(() => ({ cancel: vi.fn() }));
		// jsdom has no Web Animations API.
		(HTMLElement.prototype as unknown as { animate: unknown }).animate = animate;
	});

	afterEach(() => {
		delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate;
	});

	it('slides the new tab in from the side of the tab you moved to', async () => {
		const { rerender } = renderInbox(inbox('important', [email('i1', 'Dana', 'A')]));
		expect(listMotion()).toEqual([]);

		await rerender(inbox('promotions', [email('p1', 'Shop', 'A')]));
		expect(slides()).toEqual(['translateX(24px)']);
		expect(listMotion().some((k) => k[0].opacity === 0 && k[1].opacity === 1)).toBe(true);

		await rerender(inbox('updates', [email('u1', 'Bank', 'A')]));
		expect(slides()).toEqual(['translateX(24px)', 'translateX(-24px)']);
	});

	it('keeps still for a refresh and a page turn', async () => {
		const { rerender } = renderInbox(inbox('updates', [email('u1', 'Bank', 'A')]));
		// The realtime layer re-runs the load: same tab, new objects.
		await rerender(inbox('updates', [email('u1', 'Bank', 'A'), email('u2', 'Card', 'A')]));
		await rerender(inbox('updates', [email('u3', 'Shop', 'A')], 2));
		expect(listMotion()).toEqual([]);
	});

	it('starts the new tab at its top', async () => {
		const { rerender } = renderInbox(inbox('important', [email('i1', 'Dana', 'A')]));
		scroller().scrollTop = 400;
		await rerender(inbox('important', [email('i1', 'Dana', 'A')], 2));
		expect(scroller().scrollTop).toBe(400);
		await rerender(inbox('newsletters', [email('n1', 'Digest', 'A')]));
		expect(scroller().scrollTop).toBe(0);
	});

	it('only fades when less motion is asked for', async () => {
		vi.stubGlobal(
			'matchMedia',
			vi.fn((query: string) => ({ matches: query.includes('reduce'), media: query }))
		);
		const { rerender } = renderInbox(inbox('important', [email('i1', 'Dana', 'A')]));
		await rerender(inbox('promotions', [email('p1', 'Shop', 'A')]));
		expect(slides()).toEqual([]);
		expect(listMotion()).toEqual([[{ opacity: 0 }, { opacity: 1 }]]);
	});
});

describe('EmailList reading pane', () => {
	const data = mocks.page.data as Record<string, unknown>;
	const saved = { ...data };
	let server: Record<string, boolean> = {};

	function message(keywords: Record<string, boolean>): Email {
		return {
			...email('m1', 'Shop', 'I'),
			subject: 'Your order shipped',
			keywords: { $seen: true, ...keywords },
			attachments: [],
			htmlBody: [{ partId: '1', type: 'text/html' }],
			bodyValues: { '1': { value: '<p>Hi</p>' } }
		} as unknown as Email;
	}

	const tabs = (active: string) => ({ active, unread: { important: 0, updates: 0, newsletters: 0, promotions: 0 } }) as never;
	const detailFetches = () => fetchMock.mock.calls.filter(([u]) => String(u) === '/api/email/m1/detail').length;

	async function openInPane(keywords: Record<string, boolean>, active: string) {
		server = keywords;
		const view = render(EmailList, {
			props: { emails: [message(keywords)], total: 1, title: 'Inbox', mailboxId: 'I', inboxTabs: tabs(active) },
			context: new Map<string, unknown>([
				['labels', []],
				['readingPane', writable(true)]
			])
		});
		await fireEvent.click(screen.getByText('Your order shipped').closest('a') as HTMLElement, { button: 0, detail: 1 });
		await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Your order shipped' })).toBeTruthy());
		return view;
	}

	beforeEach(() => {
		Object.assign(data, {
			autoLoadImages: 'never',
			markReadDelay: 0,
			userEmail: 'me@example.test',
			inboxTabsOn: true,
			mailboxes: [{ id: 'I', name: 'Inbox', role: 'inbox', parentId: null, sortOrder: 0, totalEmails: 1, unreadEmails: 0 }]
		});
		mocks.page.url = new URL('http://localhost/inbox');
		fetchMock.mockImplementation(async (input: RequestInfo | URL) =>
			String(input) === '/api/email/m1/detail'
				? new Response(JSON.stringify(message(server)), { status: 200 })
				: new Response('{}', { status: 200 })
		);
	});
	afterEach(() => {
		for (const key of Object.keys(data)) delete data[key];
		Object.assign(data, saved);
		mocks.page.url = new URL('http://localhost/folder/A');
		fetchMock.mockImplementation(async () => new Response('{}', { status: 200 }));
	});

	it('shows the tab Jev gives the open message once the list refreshes', async () => {
		const { rerender } = await openInPane({}, 'important');
		expect(screen.queryByTitle(/^In the .* tab$/)).toBeNull();

		// Jev writes $cat_updates; the push refreshes the Important list, which
		// no longer has the message.
		server = { $cat_updates: true };
		await rerender({ emails: [], total: 0, title: 'Inbox', mailboxId: 'I', inboxTabs: tabs('important') });
		await waitFor(() => expect(screen.getByTitle('In the Updates tab')).toBeTruthy());
		expect(screen.getByRole('heading', { level: 1, name: 'Your order shipped' })).toBeTruthy();
	});

	it('follows the open message to another tab, from its row while the list still has it', async () => {
		const { rerender } = await openInPane({ $cat_updates: true }, 'updates');
		await waitFor(() => expect(screen.getByTitle('In the Updates tab')).toBeTruthy());
		const before = detailFetches();

		// Still in the list: its row says where it is, and nothing is fetched.
		await rerender({ emails: [message({ $cat_promotions: true })], total: 1, title: 'Inbox', mailboxId: 'I', inboxTabs: tabs('updates') });
		await waitFor(() => expect(screen.getByTitle('In the Promotions tab')).toBeTruthy());
		expect(screen.queryByTitle('In the Updates tab')).toBeNull();
		expect(detailFetches()).toBe(before);

		// Moved to Important: it leaves the list, and is read again.
		server = {};
		await rerender({ emails: [], total: 0, title: 'Inbox', mailboxId: 'I', inboxTabs: tabs('updates') });
		await waitFor(() => expect(screen.queryByTitle(/^In the .* tab$/)).toBeNull());
		expect(detailFetches()).toBe(before + 1);
	});
});

describe('EmailList divider beside the reading pane', () => {
	const props = () => ({ emails: [email('m1', 'Dana', 'A')], total: 1, title: 'Inbox', mailboxId: 'A' });
	const open = () =>
		render(EmailList, {
			props: props(),
			context: new Map<string, unknown>([
				['labels', []],
				['readingPane', writable(true)]
			])
		});
	const listColumn = () =>
		(screen.getByRole('separator', { name: 'Resize the message list' }).previousElementSibling as HTMLElement).style.width;

	afterEach(async () => {
		(await import('$lib/stores/paneWidths')).listWidth.set(420);
	});

	it('keeps the width you set when another folder opens a new list', async () => {
		open();
		expect(listColumn()).toBe('420px');
		await fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize the message list' }), { key: 'ArrowRight', shiftKey: true });
		expect(listColumn()).toBe('484px');

		// Each folder is its own page: the list is replaced, not reused.
		cleanup();
		open();
		expect(listColumn()).toBe('484px');
		expect(document.cookie).toContain('pane_list_width=484');
	});

	it('goes back to the default on a double-click', async () => {
		open();
		const divider = screen.getByRole('separator', { name: 'Resize the message list' });
		await fireEvent.keyDown(divider, { key: 'End' });
		expect(listColumn()).toBe('900px');
		await fireEvent.dblClick(divider);
		expect(listColumn()).toBe('420px');
	});
});

describe('EmailList dates', () => {
	it('has no date headings, and each row carries its own date', () => {
		const today = new Date();
		today.setHours(9, 30, 0, 0);
		const yesterday = new Date(today);
		yesterday.setDate(today.getDate() - 1);
		const lastYear = new Date(today.getFullYear() - 1, 2, 14, 9);
		render(EmailList, {
			props: {
				emails: [
					{ ...email('a', 'Dana', 'A'), receivedAt: today.toISOString() },
					{ ...email('b', 'Elaine', 'A'), receivedAt: yesterday.toISOString() },
					{ ...email('c', 'Old', 'A'), receivedAt: lastYear.toISOString() }
				],
				total: 3,
				title: 'Inbox',
				mailboxId: 'A'
			},
			context: new Map<string, unknown>([
				['labels', []],
				['readingPane', writable(false)]
			])
		});
		// The old collapsible headings were buttons naming the day.
		expect(screen.queryByRole('button', { name: /^(today|yesterday)/i })).toBeNull();
		const times = [...document.querySelectorAll('time')].map((t) => t.textContent?.trim());
		expect(times).toEqual([
			today.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }),
			'Yesterday',
			lastYear.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
		]);
	});
});
