// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';

const mocks = vi.hoisted(() => ({
	leaveGuard: null as ((navigation: { willUnload: boolean; cancel: () => void }) => void) | null
}));

vi.mock('$app/navigation', () => ({
	invalidateAll: vi.fn(async () => {}),
	goto: vi.fn(),
	beforeNavigate: (guard: typeof mocks.leaveGuard) => {
		mocks.leaveGuard = guard;
	}
}));
vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/settings/calendar') } }));

import Harness from './SettingsHarness.svelte';
import Calendar from './calendar/+page.svelte';
import Appearance from './appearance/+page.svelte';
import Reset from './reset/+page.svelte';

const data = { calendarWeekStart: 1, theme: 'dark', density: 'comfortable', readingPane: 'on' };
const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
import { bar, barShown, barText, discardButton, saveButton } from '$lib/settings/save-bar.testing';

beforeEach(() => {
	fetchMock.mockReset().mockImplementation(async () => Response.json({ success: true }));
	vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe('the settings Save bar', () => {
	it('is hidden on a page with settings until one is changed, taking its room all along', async () => {
		render(Harness, { props: { page: Calendar, data } as never });
		// In the layout from the start, so showing it moves nothing.
		expect(bar()).toBeTruthy();
		expect(barShown()).toBe(false);
		expect(saveButton()).toBeNull();

		await fireEvent.change(screen.getByLabelText('Week starts on'), { target: { value: '0' } });
		expect(barShown()).toBe(true);
		expect(saveButton()?.disabled).toBe(false);
	});

	it('shows it is saving, with both buttons disabled, then says "Saved" and goes', async () => {
		let answer!: (res: Response) => void;
		fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => (answer = resolve)));
		render(Harness, { props: { page: Calendar, data } as never });
		await fireEvent.change(screen.getByLabelText('Week starts on'), { target: { value: '0' } });
		await fireEvent.click(saveButton()!);

		expect(saveButton()).toBeNull();
		const saving = screen.getByRole('button', { name: 'Saving…' }) as HTMLButtonElement;
		expect(saving.disabled).toBe(true);
		expect(discardButton()!.disabled).toBe(true);

		answer(Response.json({ success: true }));
		await vi.waitFor(() => expect(barText()).toBe('Saved'));
		expect(saveButton()).toBeNull();
		expect(discardButton()).toBeNull();
		await vi.waitFor(() => expect(barShown()).toBe(false), { timeout: 3000 });
	});

	it('stays away from a page that only has actions', () => {
		render(Harness, { props: { page: Reset, data } as never });
		expect(screen.getByRole('heading', { name: 'Reset' })).toBeTruthy();
		expect(saveButton()).toBeNull();
	});

	it('follows the page that is open as one settings page gives way to another', async () => {
		const { rerender } = render(Harness, { props: { page: Calendar, data } as never });
		await fireEvent.change(screen.getByLabelText('Week starts on'), { target: { value: '0' } });
		await fireEvent.click(saveButton()!);
		expect(await screen.findByText('Saved')).toBeTruthy();

		// On to a page with no settings: no bar, and no "Saved" left behind.
		await rerender({ page: Reset, data } as never);
		expect(saveButton()).toBeNull();
		expect(screen.queryByText('Saved')).toBeNull();

		// And to another with its own: no bar until it has a change of its own.
		await rerender({ page: Appearance, data } as never);
		expect(barShown()).toBe(false);
		expect(screen.queryByText('Saved')).toBeNull();
		await fireEvent.click(screen.getByRole('switch', { name: 'Reading pane' }));
		await fireEvent.click(saveButton()!);
		expect(await screen.findByText('Saved')).toBeTruthy();

		expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
			'/api/preferences/calendar',
			'/api/preferences/reading-pane'
		]);
	});

	it('doesn’t ask about leaving a page whose changes were saved, or one with no settings', async () => {
		const confirm = vi.fn(() => false);
		vi.stubGlobal('confirm', confirm);
		const leave = () => {
			const cancel = vi.fn();
			mocks.leaveGuard!({ willUnload: false, cancel });
			return cancel;
		};

		const { rerender } = render(Harness, { props: { page: Calendar, data } as never });
		await fireEvent.change(screen.getByLabelText('Week starts on'), { target: { value: '6' } });
		expect(leave()).toHaveBeenCalled();

		await fireEvent.click(saveButton()!);
		await screen.findByText('Saved');
		expect(leave()).not.toHaveBeenCalled();

		await rerender({ page: Reset, data } as never);
		expect(leave()).not.toHaveBeenCalled();
		expect(confirm).toHaveBeenCalledTimes(1);
	});
});
