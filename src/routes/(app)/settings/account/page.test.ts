// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';

vi.mock('$app/navigation', () => ({ invalidateAll: vi.fn(async () => {}), beforeNavigate: () => {} }));
vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/settings/account') } }));

import Page from './+page.svelte';
import Harness from '../SettingsHarness.svelte';
import { barShown, discardButton, saveButton as barSave } from '$lib/settings/save-bar.testing';

const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
const open = () => render(Harness, { props: { page: Page, data: { displayName: 'Ada' } } as never });
const name = () => screen.getByLabelText('Display name') as HTMLInputElement;
const saveButton = () => barSave()!;

beforeEach(() => {
	fetchMock.mockReset().mockImplementation(async () => Response.json({ success: true }));
	vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe('Settings → Account', () => {
	it('says what the display name is used for, which is not outgoing mail', () => {
		open();
		expect(screen.getByText(/profile card in the header, and as the organiser on calendar invitations/)).toBeTruthy();
		expect(screen.queryByText(/Shown in outgoing emails/)).toBeNull();
	});

	it('saves the name when Save is pressed, not on leaving the field or on Enter', async () => {
		open();
		await fireEvent.input(name(), { target: { value: ' Ada Lovelace ' } });
		await fireEvent.keyDown(name(), { key: 'Enter' });
		await fireEvent.blur(name());
		expect(fetchMock).not.toHaveBeenCalled();

		await fireEvent.click(saveButton());
		expect(await screen.findByText('Saved')).toBeTruthy();

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe('/api/preferences/settings');
		expect(JSON.parse(String(init?.body))).toEqual({ displayName: ' Ada Lovelace ' });
		// Shown as the server stored it.
		expect(name().value).toBe('Ada Lovelace');
	});

	it('shows the server’s reason when it refuses the name', async () => {
		fetchMock.mockImplementationOnce(async () => Response.json({ error: 'Name is too long' }, { status: 400 }));
		open();
		await fireEvent.input(name(), { target: { value: 'Someone else' } });
		await fireEvent.click(saveButton());

		expect(await screen.findByText('Name is too long')).toBeTruthy();
		expect(name().value).toBe('Someone else');
	});

	it('puts the saved name back on Discard, and hides the bar for a name typed back', async () => {
		open();
		expect(barShown()).toBe(false);
		await fireEvent.input(name(), { target: { value: 'Grace' } });
		expect(barShown()).toBe(true);
		await fireEvent.click(discardButton()!);
		expect(name().value).toBe('Ada');
		expect(barShown()).toBe(false);

		await fireEvent.input(name(), { target: { value: 'Adam' } });
		await fireEvent.input(name(), { target: { value: 'Ada' } });
		expect(barShown()).toBe(false);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
