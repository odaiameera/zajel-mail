// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import type { Email } from '$lib/jmap/types';

const mocks = vi.hoisted(() => ({
	page: {
		data: {
			autoLoadImages: 'contacts_only' as string,
			mailboxes: [],
			userEmail: 'me@example.test',
			markReadDelay: 1000 as number
		},
		url: new URL('http://localhost:3000/inbox')
	}
}));

vi.mock('$app/state', () => ({ page: mocks.page }));
vi.mock('$app/navigation', () => ({ goto: vi.fn(), invalidateAll: vi.fn() }));
vi.mock('$app/environment', () => ({ browser: true, dev: false, building: false }));

import EmailDetail from './EmailDetail.svelte';

const PIXEL = 'https://tracker.example/open.gif?u=42';

function email(): Email {
	return {
		id: 'M1',
		threadId: 'T1',
		mailboxIds: { inbox: true },
		keywords: { $seen: true },
		from: [{ name: 'Newsletter', email: 'news@shop.example' }],
		to: [{ name: null, email: 'me@example.test' }],
		cc: null,
		subject: 'Hello',
		receivedAt: '2026-10-20T10:00:00Z',
		preview: '',
		attachments: [],
		htmlBody: [{ partId: '1', type: 'text/html' }],
		bodyValues: { '1': { value: `<p>Hi</p><img src="${PIXEL}">` } }
	} as unknown as Email;
}

let known: boolean | null = null;
const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
	const url = String(input);
	if (url.startsWith('/api/contacts/known')) return new Response(JSON.stringify({ known }), { status: 200 });
	return new Response('{}', { status: 200 });
});

function srcdoc(): string {
	return screen.getByTitle('Email content').getAttribute('srcdoc') ?? '';
}
const contactLookups = () => fetchMock.mock.calls.filter(([u]) => String(u).startsWith('/api/contacts/known'));

beforeEach(() => {
	vi.stubGlobal('fetch', fetchMock);
	known = null;
});

afterEach(() => {
	cleanup();
	fetchMock.mockClear();
	vi.unstubAllGlobals();
});

describe('EmailDetail remote images', () => {
	it('"Never" blocks the tracker, says so, and loads it only when asked', async () => {
		mocks.page.data.autoLoadImages = 'never';
		render(EmailDetail, { email: email() });

		expect(srcdoc()).not.toContain('tracker.example');
		expect(srcdoc()).toContain('Content-Security-Policy');
		expect(srcdoc()).not.toContain('/api/image-proxy');
		expect(contactLookups()).toHaveLength(0);

		await fireEvent.click(screen.getByRole('button', { name: 'Load images' }));
		await waitFor(() => expect(srcdoc()).toContain(`/api/image-proxy?url=${encodeURIComponent(PIXEL)}`));
		// The frame policy now lets the proxy through, and the banner is gone.
		expect(srcdoc()).toMatch(/img-src [^;]*\/api\/image-proxy/);
		expect(screen.queryByRole('button', { name: 'Load images' })).toBeNull();
	});

	it('"Contacts only" loads images for a known sender', async () => {
		mocks.page.data.autoLoadImages = 'contacts_only';
		known = true;
		render(EmailDetail, { email: email() });

		await waitFor(() => expect(srcdoc()).toContain('/api/image-proxy?url='));
		expect(contactLookups()[0][0]).toBe('/api/contacts/known?email=news%40shop.example');
	});

	it('"Contacts only" keeps them blocked for a stranger, or when the lookup fails', async () => {
		mocks.page.data.autoLoadImages = 'contacts_only';
		known = false;
		render(EmailDetail, { email: email() });
		await waitFor(() => expect(contactLookups()).toHaveLength(1));
		expect(srcdoc()).not.toContain('tracker.example');
		expect(screen.getByRole('button', { name: 'Load images' })).toBeTruthy();
		cleanup();

		known = null; // no contacts on the server
		render(EmailDetail, { email: email() });
		await waitFor(() => expect(contactLookups()).toHaveLength(2));
		expect(srcdoc()).not.toContain('tracker.example');
	});

	it('"Always" proxies without asking about contacts', () => {
		mocks.page.data.autoLoadImages = 'always';
		render(EmailDetail, { email: email() });
		expect(srcdoc()).toContain('/api/image-proxy?url=');
		expect(srcdoc()).not.toMatch(/src="https:\/\/tracker/);
		expect(contactLookups()).toHaveLength(0);
	});
});

describe('EmailDetail attachments', () => {
	it('lists real attachments whatever their Content-ID or disposition, and not the images the body draws', () => {
		mocks.page.data.autoLoadImages = 'never';
		const e = email();
		e.bodyValues = { '1': { value: '<p>Hi</p><img src="cid:logo@shop.example">', isEncodingProblem: false, isTruncated: false } };
		e.attachments = [
			{ partId: '2', blobId: 'B-logo', type: 'image/png', name: 'logo.png', size: 1200, cid: 'logo@shop.example', disposition: 'inline' },
			// Outlook puts a Content-ID on ordinary attachments.
			{ partId: '3', blobId: 'B-report', type: 'application/pdf', name: 'report.pdf', size: 52_000, cid: 'f_abc@namprd.outlook.com', disposition: 'attachment' },
			// Apple Mail sends a file placed in the text as inline.
			{ partId: '4', blobId: 'B-notes', type: 'application/pdf', name: 'notes.pdf', size: 8_000, cid: null, disposition: 'inline' }
		];
		render(EmailDetail, { email: e });

		expect(screen.getByText('report.pdf')).toBeTruthy();
		expect(screen.getByText('notes.pdf')).toBeTruthy();
		expect(screen.queryByText('logo.png')).toBeNull();
		expect(screen.getByText(/2 attachments/)).toBeTruthy();
		// The logo is in the body, where it belongs.
		expect(srcdoc()).toContain('/api/email/M1/attachment/B-logo');
	});
});

describe('EmailDetail header', () => {
	it('keeps the subject and labels in place and switches the line below it between who-and-when and the details', async () => {
		mocks.page.data.autoLoadImages = 'never';
		render(EmailDetail, { email: email(), compact: true });

		// Folded in the reading pane: the quiet line shows, the details don't.
		const details = document.getElementById('message-head-details')!;
		expect(details.className).toContain('hidden');
		const toggle = screen.getByRole('button', { name: 'Show details' });
		expect(toggle.getAttribute('aria-expanded')).toBe('false');
		expect(screen.getByRole('heading', { name: 'Hello' })).toBeTruthy();

		await fireEvent.click(toggle);
		await waitFor(() => expect(screen.getByRole('button', { name: 'Hide details' })).toBeTruthy());
		expect(details.className).not.toContain('hidden');
		// The quiet line stays in the DOM, out of the flow, so the two can crossfade.
		const quiet = screen.getByText('Newsletter', { selector: 'button > span' }).closest('button')!;
		expect(quiet.className).toContain('absolute');
		expect(quiet.getAttribute('tabindex')).toBe('-1');
		expect(screen.getByRole('heading', { name: 'Hello' })).toBeTruthy();

		await fireEvent.click(screen.getByRole('button', { name: 'Hide details' }));
		await waitFor(() => expect(details.className).toContain('hidden'));
		expect(quiet.className).not.toContain('absolute');
	});
});

describe('EmailDetail mark as read', () => {
	const markReadCalls = () =>
		(fetchMock.mock.calls as unknown as [RequestInfo | URL, RequestInit | undefined][]).filter(
			([u, init]) => String(u) === '/api/email/M1' && init?.method === 'PATCH'
		);
	const unread = () => ({ ...email(), keywords: {} }) as Email;

	it('marks the message read after the delay from Settings → Messages', async () => {
		mocks.page.data.autoLoadImages = 'never';
		mocks.page.data.markReadDelay = 0;
		render(EmailDetail, { email: unread() });
		await waitFor(() => expect(markReadCalls()).toHaveLength(1));
		expect(JSON.parse(String(markReadCalls()[0][1]?.body))).toEqual({ action: 'markRead' });
	});

	it('leaves it unread while the delay is still running', async () => {
		mocks.page.data.autoLoadImages = 'never';
		mocks.page.data.markReadDelay = 5000;
		render(EmailDetail, { email: unread() });
		await new Promise((resolve) => setTimeout(resolve, 60));
		expect(markReadCalls()).toHaveLength(0);
	});
});

describe('EmailDetail Inbox tab', () => {
	const data = mocks.page.data as Record<string, unknown>;
	const inTab = (keywords: Record<string, boolean>, mailboxIds: Record<string, boolean> = { inbox: true }) =>
		({ ...email(), keywords: { $seen: true, ...keywords }, mailboxIds }) as Email;

	beforeEach(() => {
		mocks.page.data.autoLoadImages = 'never';
		data.mailboxes = [
			{ id: 'inbox', name: 'Inbox', role: 'inbox', parentId: null },
			{ id: 'archive', name: 'Archive', role: 'archive', parentId: null }
		];
		data.inboxTabsOn = true;
	});
	afterEach(() => {
		data.mailboxes = [];
		delete data.inboxTabsOn;
	});

	it('shows the tab a sorted message is in beside its labels', () => {
		render(EmailDetail, { email: inTab({ $cat_updates: true }) });
		// Said in words, not only in a tooltip, so it can't pass for a label.
		expect(screen.getByTitle('In the Updates tab').textContent?.replace(/\s+/g, ' ').trim()).toBe('In the Updates tab');
	});

	it('shows none for Important, outside the Inbox, or while tabs are off', () => {
		render(EmailDetail, { email: inTab({}) });
		expect(screen.queryByTitle(/ tab$/)).toBeNull();
		cleanup();

		render(EmailDetail, { email: inTab({ $cat_newsletters: true }, { archive: true }) });
		expect(screen.queryByTitle(/ tab$/)).toBeNull();
		cleanup();

		data.inboxTabsOn = false;
		render(EmailDetail, { email: inTab({ $cat_promotions: true }) });
		expect(screen.queryByTitle(/ tab$/)).toBeNull();
	});
});
