// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';

const nav = vi.hoisted(() => ({ invalidateAll: vi.fn(), beforeNavigate: () => {} }));
vi.mock('$app/navigation', () => nav);
vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/settings/inbox-tabs') } }));

import Page from './+page.svelte';
import Harness from '../SettingsHarness.svelte';
import { barShown, discardButton, saveButton } from '$lib/settings/save-bar.testing';

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

/** Requests to refuse, by method, URL and account, with the reason the server gives. */
const refuse = new Map<string, string>();

function stubFetch() {
	calls.length = 0;
	refuse.clear();
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string, init?: RequestInit) => {
			const method = init?.method ?? 'GET';
			calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
			const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
			const body = init?.body ? JSON.parse(String(init.body)) : {};
			const no = refuse.get(`${method} ${url} ${body.accountId ?? ''}`);
			if (no) return new Response(JSON.stringify({ error: no }), { status: 400 });
			if (url === '/api/jev/pins' && method === 'POST') {
				return ok({ success: true, pin: { sender: body.sender.trim().toLowerCase(), category: body.category } });
			}
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
	return render(Harness, {
		props: {
			page: Page,
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

	it('sends nothing as tabs, Jev and spam checks are changed, then both accounts on Save', async () => {
		page('live');
		await fireEvent.click(screen.getByRole('switch', { name: 'Show tabs for work@example.test' }));
		await fireEvent.click(screen.getByRole('switch', { name: 'Let Jev read new mail for me@example.test' }));
		// Jev now reads this account, so its spam checks can be set too.
		await fireEvent.change(screen.getByRole('combobox', { name: 'Spam checks for me@example.test' }), { target: { value: 'watch' } });
		expect(writes()).toEqual([]);
		expect(barShown()).toBe(true);

		await fireEvent.click(saveButton()!);
		await screen.findByText('Saved');
		expect(writes()).toEqual([
			{ method: 'POST', url: '/api/jev/settings', body: { accountId: 'a1', jevEnabled: true, spamMode: 'watch' } },
			{ method: 'POST', url: '/api/jev/settings', body: { accountId: 'a2', inboxTabs: false } }
		]);
		expect(nav.invalidateAll).toHaveBeenCalled();
	});

	it('sets spam checks per account, only once Jev reads that account', async () => {
		page('live', [account('a1', 'me@example.test', { isActive: true }), account('a2', 'work@example.test', { jevEnabled: true })]);
		const mine = screen.getByRole('combobox', { name: 'Spam checks for me@example.test' }) as HTMLSelectElement;
		const work = screen.getByRole('combobox', { name: 'Spam checks for work@example.test' }) as HTMLSelectElement;
		expect(mine.disabled).toBe(true);
		expect(work.disabled).toBe(false);
		await fireEvent.change(work, { target: { value: 'watch' } });
		expect(writes()).toEqual([]);
		await fireEvent.click(saveButton()!);
		await waitFor(() => expect(writes()).toHaveLength(1));
		expect(writes()[0]).toEqual({ method: 'POST', url: '/api/jev/settings', body: { accountId: 'a2', spamMode: 'watch' } });
	});

	it('puts the saved switches back on Discard, and hides the bar for a switch flipped back', async () => {
		page('live');
		const tabs = screen.getByRole('switch', { name: 'Show tabs for work@example.test' });
		await fireEvent.click(tabs);
		expect(tabs.getAttribute('aria-checked')).toBe('false');
		await fireEvent.click(discardButton()!);
		expect(tabs.getAttribute('aria-checked')).toBe('true');
		expect(barShown()).toBe(false);

		await fireEvent.click(tabs);
		await fireEvent.click(tabs);
		expect(barShown()).toBe(false);
		expect(writes()).toEqual([]);
	});

	it('keeps an account that saved when the other is refused, and names the one that wasn’t', async () => {
		page('live');
		refuse.set('POST /api/jev/settings a2', 'Unknown account');
		await fireEvent.click(screen.getByRole('switch', { name: 'Show tabs for me@example.test' }));
		await fireEvent.click(screen.getByRole('switch', { name: 'Show tabs for work@example.test' }));
		await fireEvent.click(saveButton()!);

		expect(await screen.findByText('The settings for work@example.test wasn’t saved: Unknown account')).toBeTruthy();
		expect(screen.getByRole('switch', { name: 'Show tabs for work@example.test' }).getAttribute('aria-checked')).toBe('false');

		// Only the refused account is sent again.
		refuse.clear();
		await fireEvent.click(saveButton()!);
		await screen.findByText('Saved');
		expect(writes().map((w) => (w.body as { accountId: string }).accountId)).toEqual(['a1', 'a2', 'a2']);
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

	it('waits for Save to move a pin to another tab', async () => {
		page('off', pinned());
		const tab = screen.getByRole('combobox', { name: 'Tab for @shop.example' }) as HTMLSelectElement;
		await fireEvent.change(tab, { target: { value: 'updates' } });
		expect(writes()).toEqual([]);
		expect(barShown()).toBe(true);

		await fireEvent.click(saveButton()!);
		await screen.findByText('Saved');
		expect(writes()).toEqual([
			{ method: 'POST', url: '/api/jev/pins', body: { accountId: 'a2', sender: '@shop.example', category: 'updates' } }
		]);
		expect(tab.value).toBe('updates');
	});

	it('puts a pin’s tab back on Discard', async () => {
		page('off', pinned());
		const tab = screen.getByRole('combobox', { name: 'Tab for boss@example.test' }) as HTMLSelectElement;
		await fireEvent.change(tab, { target: { value: 'updates' } });
		await fireEvent.click(discardButton()!);
		expect(tab.value).toBe('important');
		expect(barShown()).toBe(false);
	});

	it('adds and removes a pin at once, leaving a tab change elsewhere waiting for Save', async () => {
		page('off', pinned());
		await fireEvent.change(screen.getByRole('combobox', { name: 'Tab for boss@example.test' }), { target: { value: 'updates' } });

		await fireEvent.click(screen.getByRole('button', { name: 'Remove pin for @shop.example' }));
		await waitFor(() => expect(writes()).toHaveLength(1));
		expect(writes()[0]).toEqual({ method: 'DELETE', url: '/api/jev/pins', body: { accountId: 'a2', sender: '@shop.example', category: 'promotions' } });

		await fireEvent.input(region('Pinned senders').getAllByRole('textbox', { name: 'Sender to pin' })[0], { target: { value: 'news@shop.example' } });
		await fireEvent.click(region('Pinned senders').getAllByRole('button', { name: 'Pin' })[0]);
		await waitFor(() => expect(writes()).toHaveLength(2));
		expect(writes()[1]).toEqual({ method: 'POST', url: '/api/jev/pins', body: { accountId: 'a1', sender: 'news@shop.example', category: 'updates' } });

		// The tab change is still unsaved, and is all Save sends.
		expect(barShown()).toBe(true);
		await fireEvent.click(saveButton()!);
		await screen.findByText('Saved');
		expect(writes().slice(2)).toEqual([
			{ method: 'POST', url: '/api/jev/pins', body: { accountId: 'a1', sender: 'boss@example.test', category: 'updates' } }
		]);
	});

	it('forgets an unsaved tab change for a pin that is removed', async () => {
		page('off', pinned());
		await fireEvent.change(screen.getByRole('combobox', { name: 'Tab for @shop.example' }), { target: { value: 'updates' } });
		expect(barShown()).toBe(true);
		await fireEvent.click(screen.getByRole('button', { name: 'Remove pin for @shop.example' }));
		await waitFor(() => expect(barShown()).toBe(false));
		// Removed as it was stored.
		expect(writes()).toEqual([
			{ method: 'DELETE', url: '/api/jev/pins', body: { accountId: 'a2', sender: '@shop.example', category: 'promotions' } }
		]);
	});

	it('forgets a tab change for a pin removed elsewhere, keeping one for a pin still there', async () => {
		const { rerender } = page('off', pinned());
		await fireEvent.change(screen.getByRole('combobox', { name: 'Tab for @shop.example' }), { target: { value: 'updates' } });
		await fireEvent.change(screen.getByRole('combobox', { name: 'Tab for boss@example.test' }), { target: { value: 'updates' } });
		// Removed in another tab: new mail reruns the load, and it isn't there.
		const [a1, a2] = pinned();
		const data = (accounts: unknown[]) => ({
			page: Page,
			data: { jev: { mode: 'off', model: '', pricePerMillion: 0, excerptChars: 2000, previewLimit: 200 }, jevAccounts: accounts }
		});
		await rerender(data([a1, { ...a2, pins: [] }]) as never);
		expect(barShown()).toBe(true);
		await fireEvent.click(saveButton()!);
		await screen.findByText('Saved');
		expect(writes()).toEqual([
			{ method: 'POST', url: '/api/jev/pins', body: { accountId: 'a1', sender: 'boss@example.test', category: 'updates' } }
		]);

		// The only change was to the pin that went: nothing to save, no bar.
		calls.length = 0;
		await fireEvent.change(screen.getByRole('combobox', { name: 'Tab for boss@example.test' }), { target: { value: 'important' } });
		expect(saveButton()).not.toBeNull();
		await rerender(data([{ ...a1, pins: [] }, { ...a2, pins: [] }]) as never);
		// (The bar may still be saying "Saved" from before; nothing is unsaved.)
		expect(saveButton()).toBeNull();
		expect(discardButton()).toBeNull();
		expect(writes()).toEqual([]);
	});

	it('warns that pins do nothing while tabs are off for their account', () => {
		page('off', pinned());
		expect(region('Pinned senders').getByText('These pins do nothing until Inbox tabs are on for work@example.test.')).toBeTruthy();
		expect(region('Pinned senders').queryByText(/until Inbox tabs are on for me@example\.test/)).toBeNull();
	});
});
