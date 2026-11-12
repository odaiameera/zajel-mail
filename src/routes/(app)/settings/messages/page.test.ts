// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { writable } from 'svelte/store';

const mocks = vi.hoisted(() => ({
	invalidateAll: vi.fn(async () => {}),
	updateSettings: vi.fn(async () => {}),
	// The settings layout's leave guard, as it hands it to SvelteKit.
	leaveGuard: null as ((navigation: { willUnload: boolean; cancel: () => void }) => void) | null
}));

vi.mock('$app/navigation', () => ({
	invalidateAll: mocks.invalidateAll,
	beforeNavigate: (guard: typeof mocks.leaveGuard) => {
		mocks.leaveGuard = guard;
	}
}));
vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/settings/messages') } }));
vi.mock('$lib/stores/userState', () => ({
	// As the server returns it: every preference is a string.
	userState: writable({ loaded: true, displayName: null, settings: { defaultPageSize: '25' } }),
	updateSettings: mocks.updateSettings
}));

import Page from './+page.svelte';
import Harness from '../SettingsHarness.svelte';
import { barShown, barText, discardButton, saveButton as barSave } from '$lib/settings/save-bar.testing';
import { userState } from '$lib/stores/userState';

/** The mocked user store, to stand in for it loading late. */
const store = userState as unknown as { set(value: { loaded: boolean; displayName: null; settings: Record<string, unknown> }): void };

const data = {
	markReadDelay: 1000,
	autoLoadImages: 'contacts_only',
	defaultSort: 'date_desc',
	trashRetentionDays: 0,
	otpTrashAfterCopy: true
};

const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();

/** The page inside the settings layout, which is where the Save bar lives. */
function open(overrides: Partial<typeof data> = {}) {
	return render(Harness, { props: { page: Page, data: { ...data, ...overrides } } as never });
}

const select = (label: string) => screen.getByLabelText(label) as HTMLSelectElement;
const seconds = () => screen.getByLabelText('Mark as read after (seconds)') as HTMLInputElement;
const saveButton = () => barSave()!;
const sent = () => fetchMock.mock.calls.map(([url, init]) => ({ url, body: JSON.parse(String(init?.body)) }));

beforeEach(() => {
	fetchMock.mockReset().mockImplementation(async () => Response.json({ success: true }));
	vi.stubGlobal('fetch', fetchMock);
	mocks.updateSettings.mockReset().mockResolvedValue(undefined);
	mocks.invalidateAll.mockClear();
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe('Settings → Messages', () => {
	it('shows the saved page size after a reload, although it is stored as a string', () => {
		render(Page, { props: { data } as never });
		expect(select('Messages per page').value).toBe('25');
	});

	it('takes the page size from the user store when that loads after the page has opened', async () => {
		// Opened straight on this address: the store hasn't loaded yet.
		store.set({ loaded: false, displayName: null, settings: {} });
		try {
			open();
			expect(select('Messages per page').value).toBe('50');

			store.set({ loaded: true, displayName: null, settings: { defaultPageSize: '25' } });
			await vi.waitFor(() => expect(select('Messages per page').value).toBe('25'));
			// It arrived as the saved value, not as a change.
			expect(barShown()).toBe(false);

			// Once it is known, the store changing no longer moves the form.
			store.set({ loaded: true, displayName: null, settings: { defaultPageSize: '100' } });
			await Promise.resolve();
			expect(select('Messages per page').value).toBe('25');
		} finally {
			store.set({ loaded: true, displayName: null, settings: { defaultPageSize: '25' } });
		}
	});

	it('shows "Mark as read after" in seconds, though it is stored in milliseconds', () => {
		open({ markReadDelay: 1500 });
		expect(seconds().value).toBe('1.5');
		expect(screen.getByText(/Seconds to wait before marking an open email as read/)).toBeTruthy();
	});

	it('shows no Save bar until something is changed, and none once it is changed back', async () => {
		open();
		expect(barShown()).toBe(false);
		expect(barSave()).toBeNull();
		expect(discardButton()).toBeNull();

		await fireEvent.change(select('Default sort'), { target: { value: 'subject' } });
		expect(barShown()).toBe(true);
		expect(barText()).toBe('Unsaved changes');

		await fireEvent.change(select('Default sort'), { target: { value: 'date_desc' } });
		expect(barShown()).toBe(false);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('sends nothing while settings are changed, and only what changed once Save is pressed', async () => {
		open();
		await fireEvent.change(select('Default sort'), { target: { value: 'date_asc' } });
		await fireEvent.input(seconds(), { target: { value: '2.5' } });
		await fireEvent.click(screen.getByRole('switch', { name: 'Trash sign-in code emails after copying' }));

		expect(fetchMock).not.toHaveBeenCalled();
		expect(mocks.updateSettings).not.toHaveBeenCalled();
		expect(screen.getByText('Unsaved changes')).toBeTruthy();
		expect(saveButton().disabled).toBe(false);

		await fireEvent.click(saveButton());
		expect(await screen.findByText('Saved')).toBeTruthy();

		// One request, in milliseconds, without the settings left alone.
		expect(sent()).toEqual([
			{ url: '/api/preferences/mail', body: { markReadDelay: 2500, defaultSort: 'date_asc', otpTrashAfterCopy: false } }
		]);
		expect(mocks.updateSettings).not.toHaveBeenCalled();
		expect(mocks.invalidateAll).toHaveBeenCalledTimes(1);
		// Nothing left to save: "Saved", then the bar goes.
		expect(barSave()).toBeNull();
		expect(discardButton()).toBeNull();
		await vi.waitFor(() => expect(barShown()).toBe(false), { timeout: 3000 });
	});

	it('saves the page size through the user store, and nothing else with it', async () => {
		open();
		await fireEvent.change(select('Messages per page'), { target: { value: '100' } });
		await fireEvent.click(saveButton());
		await screen.findByText('Saved');

		expect(mocks.updateSettings).toHaveBeenCalledWith({ settings: { defaultPageSize: 100 } });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('puts the loaded values back on Discard, without sending anything', async () => {
		open();
		await fireEvent.change(select('Default sort'), { target: { value: 'subject' } });
		await fireEvent.change(select('Empty Trash automatically'), { target: { value: '30' } });
		await fireEvent.input(seconds(), { target: { value: '9' } });

		await fireEvent.click(discardButton()!);

		expect(select('Default sort').value).toBe('date_desc');
		expect(select('Empty Trash automatically').value).toBe('0');
		expect(seconds().value).toBe('1');
		expect(barShown()).toBe(false);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('shows why a save failed, and keeps the changes so Save can be pressed again', async () => {
		fetchMock.mockImplementationOnce(async () => Response.json({ error: 'invalid defaultSort' }, { status: 400 }));
		open();
		await fireEvent.change(select('Default sort'), { target: { value: 'from' } });
		await fireEvent.click(saveButton());

		expect(await screen.findByText('invalid defaultSort')).toBeTruthy();
		expect(screen.queryByText('Saved')).toBeNull();
		expect(select('Default sort').value).toBe('from');
		expect(saveButton().disabled).toBe(false);

		// The second press goes through.
		await fireEvent.click(saveButton());
		expect(await screen.findByText('Saved')).toBeTruthy();
		expect(screen.queryByText('invalid defaultSort')).toBeNull();
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it('reports a page size the store refused', async () => {
		mocks.updateSettings.mockRejectedValueOnce(new Error('Couldn’t save. Try again.'));
		open();
		await fireEvent.change(select('Messages per page'), { target: { value: '10' } });
		await fireEvent.click(saveButton());

		expect(await screen.findByText('Couldn’t save. Try again.')).toBeTruthy();
		expect(saveButton().disabled).toBe(false);
		expect(select('Messages per page').value).toBe('10');
	});

	it('keeps what saved when the other request fails, and names what didn’t', async () => {
		mocks.updateSettings.mockRejectedValueOnce(new Error('Unauthorized'));
		open();
		await fireEvent.change(select('Default sort'), { target: { value: 'from' } });
		await fireEvent.change(select('Messages per page'), { target: { value: '10' } });
		await fireEvent.click(saveButton());

		expect(await screen.findByText('Messages per page wasn’t saved: Unauthorized')).toBeTruthy();
		expect(sent()).toEqual([{ url: '/api/preferences/mail', body: { defaultSort: 'from' } }]);

		// Only the page size is still unsaved: Save sends just that again.
		mocks.updateSettings.mockResolvedValueOnce(undefined);
		await fireEvent.click(saveButton());
		await screen.findByText('Saved');
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(mocks.updateSettings).toHaveBeenCalledTimes(2);
		expect(select('Default sort').value).toBe('from');
	});

	it('saves another setting when the stored delay is outside today’s limits', async () => {
		open({ markReadDelay: 30_000 });
		await fireEvent.change(select('Default sort'), { target: { value: 'date_asc' } });
		expect(barText()).toBe('Unsaved changes');
		await fireEvent.click(saveButton());
		expect(await screen.findByText('Saved')).toBeTruthy();
		expect(sent()).toEqual([{ url: '/api/preferences/mail', body: { defaultSort: 'date_asc' } }]);
	});

	it('refuses a delay outside the server’s 0 to 10 seconds before sending it', async () => {
		open();
		await fireEvent.input(seconds(), { target: { value: '11' } });

		expect(barText()).toBe('“Mark as read after” takes 0 to 10 seconds.');
		expect(saveButton().disabled).toBe(true);
		await fireEvent.keyDown(window, { key: 's', ctrlKey: true });
		expect(fetchMock).not.toHaveBeenCalled();

		await fireEvent.input(seconds(), { target: { value: '10' } });
		expect(barText()).toBe('Unsaved changes');
		expect(saveButton().disabled).toBe(false);
	});

	it('keeps what is being typed when the page’s data reloads in the background', async () => {
		const { rerender } = open();
		await fireEvent.input(seconds(), { target: { value: '4' } });

		// New mail arriving reruns every load; the server still has the old values.
		await rerender({ page: Page, data: { ...data, markReadDelay: 3000, defaultSort: 'subject' } } as never);

		expect(seconds().value).toBe('4');
		expect(select('Default sort').value).toBe('date_desc');
		expect(saveButton().disabled).toBe(false);

		// Discard goes back to what the page opened with, not to the reload.
		await fireEvent.click(discardButton()!);
		expect(seconds().value).toBe('1');
	});

	it('saves on Ctrl+S and on Cmd+S while the bar is showing', async () => {
		open();
		// No bar: the shortcut is the browser's, and nothing is sent.
		expect(await fireEvent.keyDown(window, { key: 's', ctrlKey: true })).toBe(true);
		expect(fetchMock).not.toHaveBeenCalled();

		await fireEvent.change(select('Default sort'), { target: { value: 'date_asc' } });
		expect(await fireEvent.keyDown(window, { key: 's', ctrlKey: true })).toBe(false);
		await screen.findByText('Saved');
		expect(sent()).toEqual([{ url: '/api/preferences/mail', body: { defaultSort: 'date_asc' } }]);

		await fireEvent.change(select('Default sort'), { target: { value: 'from' } });
		expect(await fireEvent.keyDown(window, { key: 'S', metaKey: true })).toBe(false);
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

		// A plain "s" is just a letter.
		expect(await fireEvent.keyDown(window, { key: 's' })).toBe(true);
	});

	describe('leaving with unsaved changes', () => {
		const leave = (willUnload = false) => {
			const cancel = vi.fn();
			mocks.leaveGuard!({ willUnload, cancel });
			return cancel;
		};

		it('lets a navigation through untouched when nothing changed', () => {
			const confirm = vi.fn(() => true);
			vi.stubGlobal('confirm', confirm);
			open();
			expect(leave()).not.toHaveBeenCalled();
			expect(confirm).not.toHaveBeenCalled();
		});

		it('asks first, and stays on the page with the changes when the answer is no', async () => {
			const confirm = vi.fn(() => false);
			vi.stubGlobal('confirm', confirm);
			open();
			await fireEvent.change(select('Default sort'), { target: { value: 'from' } });

			expect(leave()).toHaveBeenCalledTimes(1);
			expect(confirm).toHaveBeenCalledWith('You have unsaved changes. Leave without saving?');
			expect(select('Default sort').value).toBe('from');
		});

		it('leaves, dropping the changes, when the answer is yes', async () => {
			vi.stubGlobal('confirm', vi.fn(() => true));
			open();
			await fireEvent.change(select('Default sort'), { target: { value: 'from' } });

			expect(leave()).not.toHaveBeenCalled();
			await vi.waitFor(() => expect(select('Default sort').value).toBe('date_desc'));
			expect(fetchMock).not.toHaveBeenCalled();
		});

		it('leaves closing or reloading the tab to the browser’s own prompt', async () => {
			const confirm = vi.fn(() => true);
			vi.stubGlobal('confirm', confirm);
			const unload = () => {
				const event = new Event('beforeunload', { cancelable: true });
				window.dispatchEvent(event);
				return event.defaultPrevented;
			};
			open();
			// Nothing changed: the tab just closes.
			expect(unload()).toBe(false);

			await fireEvent.change(select('Default sort'), { target: { value: 'from' } });
			// Holding up the unload is what makes the browser ask.
			expect(unload()).toBe(true);
			expect(leave(true)).not.toHaveBeenCalled();
			expect(confirm).not.toHaveBeenCalled();
			expect(select('Default sort').value).toBe('from');
		});
	});
});
