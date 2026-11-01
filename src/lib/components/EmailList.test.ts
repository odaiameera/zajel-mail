// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte';
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
