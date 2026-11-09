// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte';
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
	},
	navigating: { to: null }
}));

vi.mock('$app/state', () => ({ page: mocks.page, navigating: mocks.navigating }));
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
