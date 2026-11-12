// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';

const mocks = vi.hoisted(() => ({ invalidateAll: vi.fn(async () => {}) }));
vi.mock('$app/navigation', () => ({ invalidateAll: mocks.invalidateAll, beforeNavigate: () => {} }));
vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/settings/calendar') } }));

import Page from './+page.svelte';
import Harness from '../SettingsHarness.svelte';
import { barShown, discardButton, saveButton } from '$lib/settings/save-bar.testing';

const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
const open = () => render(Harness, { props: { page: Page, data: { calendarWeekStart: 1 } } as never });
const weekStart = () => screen.getByLabelText('Week starts on') as HTMLSelectElement;
const sent = () => fetchMock.mock.calls.map(([url, init]) => ({ url, body: JSON.parse(String(init?.body)) }));

beforeEach(() => {
	fetchMock.mockReset().mockImplementation(async () => Response.json({ success: true }));
	vi.stubGlobal('fetch', fetchMock);
	mocks.invalidateAll.mockClear();
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe('Settings → Calendar', () => {
	it('sends the week start only when Save is pressed, as before', async () => {
		open();
		await fireEvent.change(weekStart(), { target: { value: '6' } });
		expect(fetchMock).not.toHaveBeenCalled();
		expect(barShown()).toBe(true);

		await fireEvent.click(saveButton()!);
		expect(await screen.findByText('Saved')).toBeTruthy();
		expect(sent()).toEqual([{ url: '/api/preferences/calendar', body: { weekStart: 6 } }]);
		expect(mocks.invalidateAll).toHaveBeenCalled();
	});

	it('keeps the change and shows the server’s reason when it is refused', async () => {
		fetchMock.mockImplementationOnce(async () => Response.json({ error: 'Not signed in' }, { status: 401 }));
		open();
		await fireEvent.change(weekStart(), { target: { value: '0' } });
		await fireEvent.click(saveButton()!);
		expect(await screen.findByText('Not signed in')).toBeTruthy();
		expect(weekStart().value).toBe('0');
		expect(saveButton()!.disabled).toBe(false);
	});

	it('goes back to the saved day on Discard, and hides the bar for a change undone by hand', async () => {
		open();
		await fireEvent.change(weekStart(), { target: { value: '0' } });
		await fireEvent.click(discardButton()!);
		expect(weekStart().value).toBe('1');
		expect(barShown()).toBe(false);

		await fireEvent.change(weekStart(), { target: { value: '6' } });
		await fireEvent.change(weekStart(), { target: { value: '1' } });
		expect(barShown()).toBe(false);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
