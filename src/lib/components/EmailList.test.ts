// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { writable } from 'svelte/store';
import type { Email } from '$lib/jmap/types';

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
