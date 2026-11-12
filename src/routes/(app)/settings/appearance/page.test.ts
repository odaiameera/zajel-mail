// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';

const mocks = vi.hoisted(() => ({
	invalidateAll: vi.fn(async () => {}),
	leaveGuard: null as ((navigation: { willUnload: boolean; cancel: () => void }) => void) | null
}));

vi.mock('$app/navigation', () => ({
	invalidateAll: mocks.invalidateAll,
	beforeNavigate: (guard: typeof mocks.leaveGuard) => {
		mocks.leaveGuard = guard;
	}
}));
vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/settings/appearance') } }));

import Page from './+page.svelte';
import Harness from '../SettingsHarness.svelte';
import { barShown, discardButton, saveButton as barSave } from '$lib/settings/save-bar.testing';

const data = { theme: 'dark', density: 'comfortable', readingPane: 'on' };
const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();

const open = () => render(Harness, { props: { page: Page, data } as never });
const select = (label: string) => screen.getByLabelText(label) as HTMLSelectElement;
const saveButton = () => barSave()!;
const isLight = () => document.documentElement.classList.contains('light');
const themeColor = () => document.querySelector('meta[name=theme-color]')?.getAttribute('content');
const sent = () => fetchMock.mock.calls.map(([url, init]) => ({ url, body: JSON.parse(String(init?.body)) }));

beforeEach(() => {
	fetchMock.mockReset().mockImplementation(async () => Response.json({ success: true }));
	vi.stubGlobal('fetch', fetchMock);
	// What app.html gives the page: the theme-color meta, and the app shell.
	document.head.innerHTML = '<meta name="theme-color" content="#010409">';
	document.documentElement.classList.remove('light');
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe('Settings → Appearance', () => {
	it('previews a theme as it is picked, without saving it', async () => {
		open();
		await fireEvent.change(select('Theme'), { target: { value: 'light' } });

		expect(isLight()).toBe(true);
		expect(themeColor()).toBe('#f6f8fa');
		expect(fetchMock).not.toHaveBeenCalled();
		expect(screen.getByText('Unsaved changes')).toBeTruthy();
	});

	it('takes the preview back on Discard', async () => {
		open();
		await fireEvent.change(select('Theme'), { target: { value: 'light' } });
		await fireEvent.click(discardButton()!);

		expect(isLight()).toBe(false);
		expect(themeColor()).toBe('#010409');
		expect(select('Theme').value).toBe('dark');
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('takes the preview back when the page is left without saving', async () => {
		vi.stubGlobal('confirm', vi.fn(() => true));
		open();
		await fireEvent.change(select('Theme'), { target: { value: 'light' } });

		const cancel = vi.fn();
		mocks.leaveGuard!({ willUnload: false, cancel });

		expect(cancel).not.toHaveBeenCalled();
		expect(isLight()).toBe(false);
		expect(themeColor()).toBe('#010409');
	});

	it('keeps the preview when leaving is called off', async () => {
		vi.stubGlobal('confirm', vi.fn(() => false));
		open();
		await fireEvent.change(select('Theme'), { target: { value: 'light' } });

		const cancel = vi.fn();
		mocks.leaveGuard!({ willUnload: false, cancel });

		expect(cancel).toHaveBeenCalled();
		expect(isLight()).toBe(true);
	});

	it('previews density on the app shell and takes it back on Discard', async () => {
		const shell = document.createElement('div');
		shell.className = 'app-shell';
		document.body.append(shell);
		try {
			open();
			await fireEvent.change(select('Density'), { target: { value: 'compact' } });
			expect(shell.classList.contains('density-compact')).toBe(true);

			await fireEvent.click(discardButton()!);
			expect(shell.classList.contains('density-compact')).toBe(false);
		} finally {
			shell.remove();
		}
	});

	it('saves only what changed, each to its own endpoint, and keeps the theme', async () => {
		open();
		await fireEvent.change(select('Theme'), { target: { value: 'light' } });
		await fireEvent.click(screen.getByRole('switch', { name: 'Reading pane' }));
		await fireEvent.click(saveButton());
		expect(await screen.findByText('Saved')).toBeTruthy();

		expect(sent()).toEqual([
			{ url: '/api/preferences/theme', body: { value: 'light' } },
			{ url: '/api/preferences/reading-pane', body: { value: 'off' } }
		]);
		expect(mocks.invalidateAll).toHaveBeenCalled();
		expect(isLight()).toBe(true);
		expect(barSave()).toBeNull();
	});

	it('keeps the changes and the preview when a save fails, naming what didn’t save', async () => {
		fetchMock.mockImplementation(async (url) =>
			url === '/api/preferences/theme' ? Response.json({ error: 'No' }, { status: 500 }) : Response.json({ success: true })
		);
		open();
		await fireEvent.change(select('Theme'), { target: { value: 'light' } });
		await fireEvent.click(screen.getByRole('switch', { name: 'Reading pane' }));
		await fireEvent.click(saveButton());

		expect(await screen.findByText('Theme wasn’t saved: No')).toBeTruthy();
		expect(select('Theme').value).toBe('light');
		expect(isLight()).toBe(true);
		// The reading pane went through; only the theme is left to save.
		fetchMock.mockClear().mockImplementation(async () => Response.json({ success: true }));
		await fireEvent.click(saveButton());
		await screen.findByText('Saved');
		expect(sent()).toEqual([{ url: '/api/preferences/theme', body: { value: 'light' } }]);
	});

	it('hides the bar again when a choice is put back by hand', async () => {
		open();
		await fireEvent.change(select('Theme'), { target: { value: 'light' } });
		expect(barShown()).toBe(true);
		await fireEvent.change(select('Theme'), { target: { value: 'dark' } });
		expect(barShown()).toBe(false);
		expect(isLight()).toBe(false);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('names each switch for what it does, with its state in aria-checked', () => {
		open();
		const pane = screen.getByRole('switch', { name: 'Reading pane' });
		expect(pane.getAttribute('aria-checked')).toBe('true');
	});
});
