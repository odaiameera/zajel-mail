// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';

vi.mock('$app/navigation', () => ({ invalidateAll: vi.fn(async () => {}), beforeNavigate: () => {} }));
vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/settings/messages') } }));

import Page from './ComposerSection.svelte';
import Harness from '../SettingsHarness.svelte';
import { barShown, barText, discardButton, saveButton as barSave } from '$lib/settings/save-bar.testing';

const data = { composerFont: 'Calibri', composerFontSize: '12', autoSaveInterval: 10, undoSendSeconds: 0 };
const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();

const open = () => render(Harness, { props: { page: Page, data } as never });
const interval = () => screen.getByLabelText('Save drafts every (seconds)') as HTMLInputElement;
const saveButton = () => barSave()!;
const sent = () => fetchMock.mock.calls.map(([url, init]) => ({ url, body: JSON.parse(String(init?.body)) }));

beforeEach(() => {
	fetchMock.mockReset().mockImplementation(async () => Response.json({ success: true }));
	vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe('Settings → Messages & composer: the composer', () => {
	it('saves every change in one request when Save is pressed', async () => {
		open();
		await fireEvent.change(screen.getByLabelText('Undo send'), { target: { value: '10' } });
		await fireEvent.change(screen.getByLabelText('Default font'), { target: { value: 'Georgia' } });
		await fireEvent.input(interval(), { target: { value: '30' } });
		expect(fetchMock).not.toHaveBeenCalled();

		await fireEvent.click(saveButton());
		expect(await screen.findByText('Saved')).toBeTruthy();
		expect(sent()).toEqual([
			{ url: '/api/preferences/composer', body: { autoSaveInterval: 30, undoSendSeconds: 10, font: 'Georgia' } }
		]);
	});

	it.each(['4', '121', ''])('says why an auto-save interval of "%s" can’t be saved, without sending it', async (typed) => {
		open();
		await fireEvent.input(interval(), { target: { value: typed } });

		expect(barText()).toBe('“Save drafts every” takes 5 to 120 seconds.');
		expect(saveButton().disabled).toBe(true);
		await fireEvent.click(saveButton());
		expect(fetchMock).not.toHaveBeenCalled();
		// Still there to be corrected and saved.
		expect(interval().value).toBe(typed);
	});

	it('keeps the changes and shows the server’s reason when a save fails', async () => {
		fetchMock.mockImplementationOnce(async () => Response.json({ message: 'Unknown Undo send choice' }, { status: 400 }));
		open();
		await fireEvent.change(screen.getByLabelText('Undo send'), { target: { value: '10' } });
		await fireEvent.click(saveButton());
		expect(await screen.findByText('Unknown Undo send choice')).toBeTruthy();
		expect((screen.getByLabelText('Undo send') as HTMLSelectElement).value).toBe('10');
		expect(saveButton().disabled).toBe(false);
	});

	it('puts the saved values back on Discard and hides the bar', async () => {
		open();
		await fireEvent.change(screen.getByLabelText('Default font size'), { target: { value: '16' } });
		await fireEvent.input(interval(), { target: { value: '30' } });
		await fireEvent.click(discardButton()!);
		expect((screen.getByLabelText('Default font size') as HTMLSelectElement).value).toBe('12');
		expect(interval().value).toBe('10');
		expect(barShown()).toBe(false);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('hides the bar when a change is undone by hand', async () => {
		open();
		await fireEvent.change(screen.getByLabelText('Default font'), { target: { value: 'Georgia' } });
		expect(barShown()).toBe(true);
		await fireEvent.change(screen.getByLabelText('Default font'), { target: { value: 'Calibri' } });
		expect(barShown()).toBe(false);
	});

	it('saves another setting when the stored interval is outside today’s limits, leaving it as stored', async () => {
		// Possible through Import, which stores what the file says.
		render(Harness, { props: { page: Page, data: { ...data, autoSaveInterval: 200 } } as never });
		await fireEvent.change(screen.getByLabelText('Default font'), { target: { value: 'Georgia' } });
		expect(barText()).toBe('Unsaved changes');
		expect(saveButton().disabled).toBe(false);
		await fireEvent.click(saveButton());
		expect(await screen.findByText('Saved')).toBeTruthy();
		expect(sent()).toEqual([{ url: '/api/preferences/composer', body: { font: 'Georgia' } }]);

		// Typed, it is held to the limits.
		await fireEvent.input(interval(), { target: { value: '150' } });
		expect(barText()).toBe('“Save drafts every” takes 5 to 120 seconds.');
	});

	it('stores a decimal interval as whole seconds, rounded down, and shows it so', async () => {
		open();
		await fireEvent.input(interval(), { target: { value: '7.9' } });
		await fireEvent.click(saveButton());
		expect(await screen.findByText('Saved')).toBeTruthy();
		expect(sent()).toEqual([{ url: '/api/preferences/composer', body: { autoSaveInterval: 7 } }]);
		expect(interval().value).toBe('7');
	});

	it('accepts the limits themselves', async () => {
		open();
		await fireEvent.input(interval(), { target: { value: '120' } });
		await fireEvent.click(saveButton());
		expect(await screen.findByText('Saved')).toBeTruthy();
		expect(sent()).toEqual([{ url: '/api/preferences/composer', body: { autoSaveInterval: 120 } }]);
	});
});
