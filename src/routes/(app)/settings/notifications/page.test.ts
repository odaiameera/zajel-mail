// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';

const mocks = vi.hoisted(() => ({
	invalidateAll: vi.fn(async () => {}),
	// Whether this browser has already given permission.
	canNotify: vi.fn(() => false),
	subscribePush: vi.fn(async () => true),
	unsubscribePush: vi.fn(async () => {}),
	/** This device's push subscription, as the browser has it. */
	currentPushSubscription: vi.fn(async (): Promise<object | null> => null)
}));

vi.mock('$app/navigation', () => ({ invalidateAll: mocks.invalidateAll, beforeNavigate: () => {} }));
vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/settings/notifications') } }));
vi.mock('$lib/notifications', () => ({
	canNotify: mocks.canNotify,
	notificationSupport: () => 'supported',
	currentPushSubscription: mocks.currentPushSubscription,
	pushWantedHere: () => true,
	setPushWantedHere: () => {},
	subscribePush: mocks.subscribePush,
	unsubscribePush: mocks.unsubscribePush
}));

import Page from './+page.svelte';
import Harness from '../SettingsHarness.svelte';
import { barShown, barText, discardButton, saveButton as barSave } from '$lib/settings/save-bar.testing';
import { stepUpPrompt } from '$lib/auth/step-up';
import { get } from 'svelte/store';

const mailbox = (id: string, name: string, role: string | null) => ({ id, name, role, parentId: null, unreadEmails: 0 });
const data = {
	notificationsEnabled: false,
	notificationFolders: ['mb-inbox'],
	notifyCalendarEvents: true,
	notifyEventReminders: true,
	mailboxes: [mailbox('mb-inbox', 'Inbox', 'inbox'), mailbox('mb-news', 'News', null), mailbox('mb-sent', 'Sent', 'sent')]
};

const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
const requestPermission = vi.fn<() => Promise<NotificationPermission>>();

const open = (overrides: Partial<typeof data> = {}) =>
	render(Harness, { props: { page: Page, data: { ...data, ...overrides } } as never });
const mainSwitch = () => screen.getByRole('switch', { name: 'Enable notifications' });
const folder = (name: string) => screen.getByRole('checkbox', { name: new RegExp(name) }) as HTMLInputElement;
const saveButton = () => barSave()!;
/** The answer GET /api/telegram gives; a test links it. */
let telegram: Record<string, unknown>;
const telegramSets = () =>
	fetchMock.mock.calls
		.filter(([url, init]) => url === '/api/telegram' && init?.method === 'POST')
		.map(([, init]) => JSON.parse(String(init?.body)));
/** What was stored: the page also reads Telegram and the device list, which don't count. */
const saved = () =>
	fetchMock.mock.calls
		.filter(([url, init]) => url === '/api/preferences/notifications' && init?.method === 'POST')
		.map(([, init]) => JSON.parse(String(init?.body)));

beforeEach(() => {
	telegram = { configured: false };
	fetchMock.mockReset().mockImplementation(async (url, init) => {
		if (url === '/api/telegram' && init?.method === 'POST') {
			const body = JSON.parse(String(init.body));
			telegram = { ...telegram, ...(body.urgent !== undefined ? { urgent: body.urgent } : {}), ...(body.paused !== undefined ? { paused: body.paused } : {}) };
			return Response.json({ success: true });
		}
		if (url === '/api/telegram') return Response.json(telegram);
		if (url === '/api/push/devices') return Response.json({ devices: [] });
		return Response.json({ success: true });
	});
	vi.stubGlobal('fetch', fetchMock);
	requestPermission.mockReset().mockResolvedValue('granted');
	vi.stubGlobal('Notification', { requestPermission });
	mocks.canNotify.mockReset().mockReturnValue(false);
	mocks.subscribePush.mockClear();
	mocks.unsubscribePush.mockClear();
	mocks.currentPushSubscription.mockReset().mockResolvedValue(null);
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe('Settings → Notifications', () => {
	it('ticks the folders that notify', () => {
		open();
		expect(folder('Inbox').checked).toBe(true);
		expect(folder('News').checked).toBe(false);
		// Sent mail never notifies, so it isn't offered.
		expect(screen.queryByRole('checkbox', { name: /Sent/ })).toBeNull();
	});

	it('puts the switch back and says why when the browser refuses permission', async () => {
		requestPermission.mockResolvedValue('denied');
		open();
		await fireEvent.click(mainSwitch());

		expect(await screen.findByText(/Browser denied notification permission/)).toBeTruthy();
		expect(mainSwitch().getAttribute('aria-checked')).toBe('false');
		// Nothing was changed, so there is nothing to save or to discard.
		expect(barShown()).toBe(false);
		expect(saved()).toEqual([]);
		expect(mocks.subscribePush).not.toHaveBeenCalled();
	});

	it('asks for permission at the click, but stores the switch and subscribes the device only on Save', async () => {
		open();
		await fireEvent.click(mainSwitch());
		await vi.waitFor(() => expect(mainSwitch().getAttribute('aria-checked')).toBe('true'));

		expect(requestPermission).toHaveBeenCalledTimes(1);
		expect(saved()).toEqual([]);
		expect(mocks.subscribePush).not.toHaveBeenCalled();

		// The folders can be chosen before saving, now that the switch is on.
		expect(folder('News').disabled).toBe(false);
		await fireEvent.click(folder('News'));
		expect(saved()).toEqual([]);

		await fireEvent.click(saveButton());
		expect(await screen.findByText('Saved')).toBeTruthy();

		// One request for everything that changed.
		expect(saved()).toEqual([{ enabled: true, folders: ['mb-inbox', 'mb-news'] }]);
		expect(mocks.subscribePush).toHaveBeenCalledTimes(1);
	});

	it('turns notifications off, and this device’s push with them, only on Save', async () => {
		mocks.canNotify.mockReturnValue(true);
		open({ notificationsEnabled: true });
		await vi.waitFor(() => expect(mainSwitch().getAttribute('aria-checked')).toBe('true'));

		await fireEvent.click(mainSwitch());
		expect(mainSwitch().getAttribute('aria-checked')).toBe('false');
		expect(saved()).toEqual([]);
		expect(mocks.unsubscribePush).not.toHaveBeenCalled();

		await fireEvent.click(saveButton());
		await screen.findByText('Saved');
		expect(saved()).toEqual([{ enabled: false }]);
		expect(mocks.unsubscribePush).toHaveBeenCalledTimes(1);
	});

	it('asks a newly permitted device at the click, and subscribes it on Save, when the account already has notifications on', async () => {
		// On for the account, but this browser was never asked: the switch reads off here.
		open({ notificationsEnabled: true });
		await vi.waitFor(() => expect(mainSwitch().getAttribute('aria-checked')).toBe('false'));

		await fireEvent.click(mainSwitch());
		await vi.waitFor(() => expect(mainSwitch().getAttribute('aria-checked')).toBe('true'));
		expect(requestPermission).toHaveBeenCalledTimes(1);
		expect(mocks.subscribePush).not.toHaveBeenCalled();

		await fireEvent.click(saveButton());
		await screen.findByText('Saved');
		// The account's setting didn't change; only this device joins.
		expect(saved()).toEqual([]);
		expect(mocks.subscribePush).toHaveBeenCalledTimes(1);
	});

	it('keeps this device’s switch until Save, then subscribes it', async () => {
		mocks.canNotify.mockReturnValue(true);
		open({ notificationsEnabled: true });
		const device = () => screen.getByRole('switch', { name: 'This device' });
		await vi.waitFor(() => expect((device() as HTMLButtonElement).disabled).toBe(false));
		expect(device().getAttribute('aria-checked')).toBe('false');

		await fireEvent.click(device());
		expect(device().getAttribute('aria-checked')).toBe('true');
		expect(mocks.subscribePush).not.toHaveBeenCalled();

		await fireEvent.click(saveButton());
		await screen.findByText('Saved');
		expect(mocks.subscribePush).toHaveBeenCalledTimes(1);
		expect(saved()).toEqual([]);
	});

	it('says so, and leaves the switch unsaved, when this device can’t take push', async () => {
		mocks.canNotify.mockReturnValue(true);
		mocks.subscribePush.mockResolvedValueOnce(false);
		open({ notificationsEnabled: true });
		const device = () => screen.getByRole('switch', { name: 'This device' });
		await vi.waitFor(() => expect((device() as HTMLButtonElement).disabled).toBe(false));
		await fireEvent.click(device());
		await fireEvent.click(saveButton());
		expect(await screen.findByText('Push couldn’t be turned on for this device.')).toBeTruthy();
		expect(device().getAttribute('aria-checked')).toBe('true');
		expect(barShown()).toBe(true);
	});

	describe('this device and the main switch', () => {
		const device = () => screen.getByRole('switch', { name: 'This device' });
		const ready = () => vi.waitFor(() => expect((device() as HTMLButtonElement).disabled).toBe(false));

		it('reads switching the main switch off and on again as no change, with this device stored off', async () => {
			mocks.canNotify.mockReturnValue(true);
			open({ notificationsEnabled: true });
			await ready();
			expect(device().getAttribute('aria-checked')).toBe('false');

			await fireEvent.click(mainSwitch());
			await vi.waitFor(() => expect(mainSwitch().getAttribute('aria-checked')).toBe('false'));
			expect(barShown()).toBe(true);
			await fireEvent.click(mainSwitch());
			await vi.waitFor(() => expect(mainSwitch().getAttribute('aria-checked')).toBe('true'));

			expect(barShown()).toBe(false);
			expect(device().getAttribute('aria-checked')).toBe('false');
			expect(saved()).toEqual([]);
			expect(mocks.subscribePush).not.toHaveBeenCalled();
			expect(mocks.unsubscribePush).not.toHaveBeenCalled();
		});

		it('takes this device along when the main switch goes from stored off to on, and subscribes it once on Save', async () => {
			mocks.canNotify.mockReturnValue(true);
			open();
			await fireEvent.click(mainSwitch());
			await vi.waitFor(() => expect(mainSwitch().getAttribute('aria-checked')).toBe('true'));
			expect(device().getAttribute('aria-checked')).toBe('true');

			await fireEvent.click(saveButton());
			await screen.findByText('Saved');
			expect(saved()).toEqual([{ enabled: true }]);
			expect(mocks.subscribePush).toHaveBeenCalledTimes(1);
		});

		it('keeps this device as the person set it when the main switch goes off and back on', async () => {
			mocks.canNotify.mockReturnValue(true);
			open({ notificationsEnabled: true });
			await ready();
			await fireEvent.click(device());
			expect(device().getAttribute('aria-checked')).toBe('true');

			await fireEvent.click(mainSwitch());
			await vi.waitFor(() => expect(mainSwitch().getAttribute('aria-checked')).toBe('false'));
			await fireEvent.click(mainSwitch());
			await vi.waitFor(() => expect(mainSwitch().getAttribute('aria-checked')).toBe('true'));
			expect(device().getAttribute('aria-checked')).toBe('true');

			await fireEvent.click(saveButton());
			await screen.findByText('Saved');
			expect(saved()).toEqual([]);
			expect(mocks.subscribePush).toHaveBeenCalledTimes(1);
		});

		it('keeps a change the person made to this device while the main switch was changed', async () => {
			// Off for the account, though this device still has its subscription.
			mocks.canNotify.mockReturnValue(true);
			mocks.currentPushSubscription.mockResolvedValue({});
			open();
			await fireEvent.click(mainSwitch());
			await vi.waitFor(() => expect(mainSwitch().getAttribute('aria-checked')).toBe('true'));
			await ready();
			expect(device().getAttribute('aria-checked')).toBe('true');
			await fireEvent.click(device());
			expect(device().getAttribute('aria-checked')).toBe('false');

			// Back to off as saved: this device stays as the person set it.
			await fireEvent.click(mainSwitch());
			await vi.waitFor(() => expect(mainSwitch().getAttribute('aria-checked')).toBe('false'));
			expect(barShown()).toBe(true);
			await fireEvent.click(saveButton());
			await screen.findByText('Saved');
			expect(saved()).toEqual([]);
			expect(mocks.unsubscribePush).toHaveBeenCalledTimes(1);
		});

		it('saves the main switch, with this device reading off, when the device can’t take push', async () => {
			mocks.canNotify.mockReturnValue(true);
			mocks.subscribePush.mockResolvedValueOnce(false);
			open();
			await fireEvent.click(mainSwitch());
			await vi.waitFor(() => expect(mainSwitch().getAttribute('aria-checked')).toBe('true'));

			await fireEvent.click(saveButton());
			expect(await screen.findByText('Saved')).toBeTruthy();
			expect(saved()).toEqual([{ enabled: true }]);
			expect(mocks.subscribePush).toHaveBeenCalledTimes(1);
			expect(device().getAttribute('aria-checked')).toBe('false');
			// Nothing left unsaved, and no error.
			expect(saveButton()).toBeFalsy();
			expect(barText()).toBe('Saved');
		});
	});

	it('keeps the changes and shows the server’s reason when the save is refused', async () => {
		mocks.canNotify.mockReturnValue(true);
		open({ notificationsEnabled: true });
		const events = () => screen.getByRole('switch', { name: 'New & updated events' });
		await vi.waitFor(() => expect((events() as HTMLButtonElement).disabled).toBe(false));
		const usual = fetchMock.getMockImplementation()!;
		fetchMock.mockImplementation(async (url, init) =>
			url === '/api/preferences/notifications' ? Response.json({ error: 'Not signed in' }, { status: 401 }) : usual(url, init)
		);
		await fireEvent.click(events());
		await fireEvent.click(saveButton());
		expect(await screen.findByText('Not signed in')).toBeTruthy();
		expect(events().getAttribute('aria-checked')).toBe('false');
		expect(saveButton().disabled).toBe(false);
	});

	it('stores the calendar switches with Save, and puts them back on Discard', async () => {
		mocks.canNotify.mockReturnValue(true);
		open({ notificationsEnabled: true });
		const reminders = () => screen.getByRole('switch', { name: 'Event reminders' });
		await vi.waitFor(() => expect(reminders().getAttribute('aria-checked')).toBe('true'));

		await fireEvent.click(reminders());
		await fireEvent.click(discardButton()!);
		expect(reminders().getAttribute('aria-checked')).toBe('true');
		expect(barShown()).toBe(false);
		expect(saved()).toEqual([]);

		await fireEvent.click(reminders());
		await fireEvent.click(saveButton());
		await screen.findByText('Saved');
		expect(saved()).toEqual([{ eventReminders: false }]);
	});

	it('reads a ticked and then unticked folder as no change', async () => {
		mocks.canNotify.mockReturnValue(true);
		open({ notificationsEnabled: true });
		await vi.waitFor(() => expect(folder('News').disabled).toBe(false));

		await fireEvent.click(folder('News'));
		expect(barShown()).toBe(true);
		expect(barText()).toBe('Unsaved changes');
		await fireEvent.click(folder('News'));
		expect(barShown()).toBe(false);
	});

	describe('Telegram', () => {
		const linked = { configured: true, linked: true, username: 'me', urgent: false, paused: false, accounts: [] };

		it('waits for Save to pause alerts, then stores it after the sign-in check', async () => {
			telegram = { ...linked };
			open();
			const paused = await screen.findByRole('switch', { name: 'Paused' });
			await fireEvent.click(paused);
			expect(paused.getAttribute('aria-checked')).toBe('true');
			expect(telegramSets()).toEqual([]);

			await fireEvent.click(saveButton());
			await screen.findByText('Saved');
			expect(telegramSets()).toEqual([{ action: 'set', paused: true }]);
			expect(barSave()).toBeNull();
		});

		it('leaves the change unsaved, without an error, when the sign-in check is closed', async () => {
			telegram = { ...linked };
			open();
			const paused = await screen.findByRole('switch', { name: 'Paused' });
			await fireEvent.click(paused);
			const usual = fetchMock.getMockImplementation()!;
			fetchMock.mockImplementation(async (url, init) =>
				url === '/api/telegram' && init?.method === 'POST' ? Response.json({ stepUp: true }, { status: 403 }) : usual(url, init)
			);
			await fireEvent.click(saveButton());
			await vi.waitFor(() => expect(get(stepUpPrompt)).not.toBeNull());
			get(stepUpPrompt)!(false);

			await vi.waitFor(() => expect(saveButton().textContent?.trim()).toBe('Save'));
			expect(barText()).toBe('Unsaved changes');
			expect(paused.getAttribute('aria-checked')).toBe('true');
		});

		it('unlinks at once, dropping a change to its switches that wasn’t saved', async () => {
			telegram = { ...linked };
			open();
			await fireEvent.click(await screen.findByRole('switch', { name: 'Paused' }));
			expect(barShown()).toBe(true);

			telegram = { configured: true, linked: false };
			await fireEvent.click(screen.getByRole('button', { name: 'Unlink' }));
			await vi.waitFor(() => expect(telegramSets()).toEqual([{ action: 'unlink' }]));
			await vi.waitFor(() => expect(barShown()).toBe(false));
		});
	});
});
