// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';

const nav = vi.hoisted(() => ({ invalidateAll: vi.fn() }));
vi.mock('$app/navigation', () => nav);

import Page from './+page.svelte';

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	nav.invalidateAll.mockClear();
});

type Mode = 'off' | 'mock' | 'live';
const account = (id: string, email: string, over: Record<string, unknown> = {}) => ({
	id,
	email,
	displayName: '',
	isActive: false,
	inboxTabs: true,
	jevEnabled: false,
	spamMode: 'off',
	pins: [] as { sender: string; category: string }[],
	month: { sorted: 0, corrected: 0, inputTokens: 0, costUsd: 0 },
	...over
});

const calls: { method: string; url: string; body: unknown }[] = [];
const writes = () => calls.filter((c) => c.method !== 'GET');

function stubFetch() {
	calls.length = 0;
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string, init?: RequestInit) => {
			const method = init?.method ?? 'GET';
			calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
			const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
			if (url.startsWith('/api/jev/backfill')) {
				return ok({ ready: true, mock: false, unsorted: 0, estimate: { inputTokens: 0, costUsd: 0 }, progress: { pending: 0, done: 0, failed: 0, skipped: 0 } });
			}
			if (url === '/api/jev/spam-report') return new Response('{}', { status: 500 });
			return ok({ success: true });
		})
	);
}

function page(mode: Mode, accounts = [account('a1', 'me@example.test', { isActive: true }), account('a2', 'work@example.test')]) {
	stubFetch();
	return render(Page, {
		props: {
			data: {
				jev: { mode, model: 'jev-1.13.0', pricePerMillion: 0.2, excerptChars: 2000, previewLimit: 200 },
				jevAccounts: accounts
			}
		} as never
	});
}

const region = (name: string) => within(screen.getByRole('region', { name }));

describe('Settings → Inbox tabs', () => {
	it('puts its sections in the order they depend on each other', () => {
		page('live');
		const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
		expect(headings).toEqual(['The four tabs', 'Let Jev sort new mail', 'Pinned senders', 'Add-ons']);
		expect(document.getElementById('pinned-senders')?.getAttribute('aria-labelledby')).toBe('pins-heading');
		expect(screen.getByRole('link', { name: 'Settings → Notifications' }).getAttribute('href')).toBe('/settings/notifications');
	});

	it('switches tabs and Jev for the account they are shown for', async () => {
		page('live');
		await fireEvent.click(screen.getByRole('switch', { name: 'Show tabs for work@example.test' }));
		await waitFor(() => expect(writes()).toHaveLength(1));
		expect(writes()[0]).toEqual({ method: 'POST', url: '/api/jev/settings', body: { accountId: 'a2', inboxTabs: false } });

		await fireEvent.click(screen.getByRole('switch', { name: 'Let Jev read new mail for me@example.test' }));
		await waitFor(() => expect(writes()).toHaveLength(2));
		expect(writes()[1]).toEqual({ method: 'POST', url: '/api/jev/settings', body: { accountId: 'a1', jevEnabled: true } });
		expect(nav.invalidateAll).toHaveBeenCalled();
	});

	it('sets spam checks per account, only once Jev reads that account', async () => {
		page('live', [account('a1', 'me@example.test', { isActive: true }), account('a2', 'work@example.test', { jevEnabled: true })]);
		const mine = screen.getByRole('combobox', { name: 'Spam checks for me@example.test' }) as HTMLSelectElement;
		const work = screen.getByRole('combobox', { name: 'Spam checks for work@example.test' }) as HTMLSelectElement;
		expect(mine.disabled).toBe(true);
		expect(work.disabled).toBe(false);
		await fireEvent.change(work, { target: { value: 'watch' } });
		await waitFor(() => expect(writes()).toHaveLength(1));
		expect(writes()[0]).toEqual({ method: 'POST', url: '/api/jev/settings', body: { accountId: 'a2', spamMode: 'watch' } });
	});

	it('says how Jev is connected: live, mock or not at all', () => {
		page('live');
		expect(region('Let Jev sort new mail').getByText(/Connected to TypeSafe with model/)).toBeTruthy();
		expect(region('Let Jev sort new mail').getByText('jev-1.13.0')).toBeTruthy();
		cleanup();
		page('mock');
		expect(region('Let Jev sort new mail').getByText(/Mock mode \(JEV_MOCK\)/)).toBeTruthy();
		cleanup();
		page('off');
		expect(region('Let Jev sort new mail').getByText(/Not configured\./)).toBeTruthy();
	});

	it('can’t switch Jev on, or spam checks, while Jev isn’t configured', () => {
		page('off', [account('a1', 'me@example.test', { isActive: true, jevEnabled: true })]);
		expect((screen.getByRole('switch', { name: 'Let Jev read new mail for me@example.test' }) as HTMLButtonElement).disabled).toBe(true);
		expect((screen.getByRole('combobox', { name: 'Spam checks for me@example.test' }) as HTMLSelectElement).disabled).toBe(true);
		expect((screen.getByRole('switch', { name: 'Show tabs for me@example.test' }) as HTMLButtonElement).disabled).toBe(false);
	});

	it('offers the backfill and "Try Jev" only when Jev is configured', async () => {
		page('off');
		expect(screen.queryByText('Sort the mail already in your Inbox')).toBeNull();
		expect(screen.queryByRole('button', { name: 'Try it' })).toBeNull();
		cleanup();
		page('live');
		await waitFor(() => expect(screen.getByText('Sort the mail already in your Inbox')).toBeTruthy());
		expect(screen.getByRole('button', { name: 'Try it' })).toBeTruthy();
		expect(screen.getByText('Try Jev on your last 200 emails')).toBeTruthy();
	});
});

describe('Settings → Inbox tabs → Pinned senders', () => {
	const pinned = () => [
		account('a1', 'me@example.test', { isActive: true, pins: [{ sender: 'boss@example.test', category: 'important' }] }),
		account('a2', 'work@example.test', { inboxTabs: false, pins: [{ sender: '@shop.example', category: 'promotions' }] })
	];

	it('adds a pin for the account it was typed under', async () => {
		page('off', pinned());
		const forms = region('Pinned senders').getAllByRole('textbox', { name: 'Sender to pin' });
		await fireEvent.input(forms[1], { target: { value: ' news@shop.example ' } });
		await fireEvent.change(region('Pinned senders').getAllByRole('combobox', { name: 'Tab' })[1], { target: { value: 'newsletters' } });
		await fireEvent.click(region('Pinned senders').getAllByRole('button', { name: 'Pin' })[1]);
		await waitFor(() => expect(writes()).toHaveLength(1));
		expect(writes()[0]).toEqual({
			method: 'POST',
			url: '/api/jev/pins',
			body: { accountId: 'a2', sender: 'news@shop.example', category: 'newsletters' }
		});
	});

	it('moves a pin to another tab, and removes it', async () => {
		page('off', pinned());
		await fireEvent.change(screen.getByRole('combobox', { name: 'Tab for @shop.example' }), { target: { value: 'updates' } });
		await waitFor(() => expect(writes()).toHaveLength(1));
		expect(writes()[0]).toEqual({ method: 'POST', url: '/api/jev/pins', body: { accountId: 'a2', sender: '@shop.example', category: 'updates' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Remove pin for @shop.example' }));
		await waitFor(() => expect(writes()).toHaveLength(2));
		expect(writes()[1]).toEqual({ method: 'DELETE', url: '/api/jev/pins', body: { accountId: 'a2', sender: '@shop.example', category: 'promotions' } });
	});

	it('warns that pins do nothing while tabs are off for their account', () => {
		page('off', pinned());
		expect(region('Pinned senders').getByText('These pins do nothing until Inbox tabs are on for work@example.test.')).toBeTruthy();
		expect(region('Pinned senders').queryByText(/until Inbox tabs are on for me@example\.test/)).toBeNull();
	});
});
