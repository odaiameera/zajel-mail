// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/svelte';
import { writable } from 'svelte/store';
import type { Email } from '$lib/jmap/types';
import type { PageData } from './$types';

const mocks = vi.hoisted(() => ({
	page: {
		data: {
			activeAccountId: 'acct-1',
			mailboxes: [{ id: 'IN', name: 'Inbox', role: 'inbox', parentId: null, sortOrder: 0, totalEmails: 1, unreadEmails: 0 }]
		},
		url: new URL('http://localhost/search?q=plumber%20quote')
	}
}));
vi.mock('$app/state', () => ({ page: mocks.page }));
vi.mock('$app/navigation', () => ({ goto: vi.fn(), invalidateAll: vi.fn() }));
vi.mock('$app/environment', () => ({ browser: true, dev: false, building: false }));

import Page from './+page.svelte';
import { parseSearch } from '$lib/search/parse';

const plumber = {
	id: 'p1',
	blobId: 'b-p1',
	threadId: 't-p1',
	mailboxIds: { IN: true },
	keywords: { $seen: true },
	from: [{ name: 'Sam', email: 'sam@plumb.example' }],
	to: [{ name: null, email: 'me@example.test' }],
	cc: null,
	subject: 'Quote from the plumber',
	receivedAt: '2026-01-01T10:00:00Z',
	size: 100,
	preview: '',
	hasAttachment: false
} as Email;

function renderResults(ranked: boolean) {
	const raw = 'plumber quote';
	const data = { raw, tokens: parseSearch(raw), emails: [plumber], total: 1, page: 1, pageSize: 50, totalPages: 1, ranked };
	return render(Page, {
		props: { data: data as unknown as PageData },
		context: new Map<string, unknown>([
			['labels', []],
			['readingPane', writable(false)]
		])
	});
}

afterEach(cleanup);

describe('search results', () => {
	it('says when matches are in relevance order rather than newest first', () => {
		renderResults(true);
		expect(screen.getByText('Best matches first')).toBeTruthy();
		cleanup();
		renderResults(false);
		expect(screen.queryByText('Best matches first')).toBeNull();
	});
});
