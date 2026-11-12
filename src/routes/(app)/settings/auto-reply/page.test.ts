// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';

vi.mock('$app/navigation', () => ({ invalidateAll: vi.fn(), beforeNavigate: () => {} }));
vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/settings/auto-reply') } }));

import Page from './+page.svelte';
import Harness from '../SettingsHarness.svelte';
import { barShown, barText, discardButton, saveButton } from '$lib/settings/save-bar.testing';

let posted: Record<string, unknown>[] = [];
let answer: { status: number; body: Record<string, unknown> } = { status: 200, body: { success: true, status: 'On' } };

beforeEach(() => {
	posted = [];
	answer = { status: 200, body: { success: true, status: 'On' } };
	vi.stubGlobal(
		'fetch',
		vi.fn(async (_url: string, init?: RequestInit) => {
			posted.push(JSON.parse(String(init?.body)));
			return Response.json(answer.body, { status: answer.status });
		})
	);
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

const saved = { enabled: false, subject: '', body: '', from: '', until: '' };
const page = (over: Record<string, unknown> = {}) =>
	render(Harness, {
		props: { page: Page, data: { autoReply: saved, status: 'Off', sent: [], multipleAccounts: false, ...over } } as never
	});

const status = () => screen.getByTestId('auto-reply-status').textContent?.replace(/\s+/g, ' ').trim();

describe('Settings → Auto-reply', () => {
	it('saves nothing until Save, then sends the whole form with the time zone', async () => {
		page();
		await fireEvent.input(screen.getByLabelText('Message'), { target: { value: 'Away this week.' } });
		await fireEvent.click(screen.getByRole('switch', { name: 'Send automatic replies' }));
		await fireEvent.input(screen.getByLabelText('Until'), { target: { value: '2026-11-28' } });
		expect(posted).toEqual([]);
		expect(barShown()).toBe(true);

		await fireEvent.click(saveButton()!);
		await waitFor(() => expect(posted).toHaveLength(1));
		expect(posted[0]).toMatchObject({ enabled: true, body: 'Away this week.', until: '2026-11-28', from: '', subject: '' });
		expect(typeof posted[0].tz).toBe('string');
	});

	it('sends the browser’s own time zone', async () => {
		const real = Intl.DateTimeFormat;
		vi.stubGlobal('Intl', {
			...Intl,
			DateTimeFormat: Object.assign(
				(...args: ConstructorParameters<typeof Intl.DateTimeFormat>) => {
					const format = new real(...args);
					const resolved = format.resolvedOptions();
					return Object.assign(format, { resolvedOptions: () => ({ ...resolved, timeZone: 'Pacific/Chatham' }) });
				},
				{ supportedLocalesOf: real.supportedLocalesOf }
			)
		});
		page({ autoReply: { ...saved, enabled: true, body: 'Away' } });
		await fireEvent.input(screen.getByLabelText('Until'), { target: { value: '2026-11-28' } });
		await fireEvent.click(saveButton()!);
		await waitFor(() => expect(posted).toHaveLength(1));
		expect(posted[0].tz).toBe('Pacific/Chatham');
	});

	it('shows each status, and the new one after a save', async () => {
		for (const s of ['Off', 'On', 'Starts 20 Nov', 'On until 28 Nov', 'Ended 28 Nov']) {
			page({ status: s });
			expect(status()).toBe(`Status: ${s}`);
			cleanup();
		}
		answer = { status: 200, body: { success: true, status: 'On until 28 Nov' } };
		page({ autoReply: { ...saved, enabled: true, body: 'Away' } });
		await fireEvent.input(screen.getByLabelText('Until'), { target: { value: '2026-11-28' } });
		await fireEvent.click(saveButton()!);
		await waitFor(() => expect(status()).toBe('Status: On until 28 Nov'));
	});

	it('won’t save an end date before the start date', async () => {
		page({ autoReply: { ...saved, enabled: true, body: 'Away' } });
		await fireEvent.input(screen.getByLabelText('From'), { target: { value: '2026-11-21' } });
		await fireEvent.input(screen.getByLabelText('Until'), { target: { value: '2026-11-20' } });
		expect(barText()).toBe('The end date is before the start date.');
		const save = saveButton()!;
		expect(save.disabled).toBe(true);
		await fireEvent.click(save);
		expect(posted).toEqual([]);

		await fireEvent.input(screen.getByLabelText('Until'), { target: { value: '2026-11-21' } });
		expect(save.disabled).toBe(false);
	});

	it('won’t switch replies on with no message to send', async () => {
		page();
		await fireEvent.click(screen.getByRole('switch', { name: 'Send automatic replies' }));
		expect(barText()).toBe('Write the message to send.');
		expect(saveButton()!.disabled).toBe(true);
		await fireEvent.input(screen.getByLabelText('Message'), { target: { value: 'Away' } });
		expect(saveButton()!.disabled).toBe(false);
	});

	it('puts the saved form back on Discard, and hides the bar for a field typed back', async () => {
		page({ autoReply: { ...saved, subject: 'Away' } });
		await fireEvent.input(screen.getByLabelText('Subject'), { target: { value: 'Out' } });
		await fireEvent.click(discardButton()!);
		expect((screen.getByLabelText('Subject') as HTMLInputElement).value).toBe('Away');
		expect(barShown()).toBe(false);

		await fireEvent.input(screen.getByLabelText('Subject'), { target: { value: 'Awa' } });
		await fireEvent.input(screen.getByLabelText('Subject'), { target: { value: 'Away' } });
		expect(barShown()).toBe(false);
		expect(posted).toEqual([]);
	});

	it('shows what the server refused', async () => {
		answer = { status: 400, body: { error: 'The start date isn’t a date.' } };
		page({ autoReply: { ...saved, enabled: true, body: 'Away' } });
		await fireEvent.input(screen.getByLabelText('Message'), { target: { value: 'Away for a week' } });
		await fireEvent.click(saveButton()!);
		expect(await screen.findByText('The start date isn’t a date.')).toBeTruthy();
		// Still there to be corrected and saved.
		expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toBe('Away for a week');
		expect(saveButton()!.disabled).toBe(false);
	});

	it('lists the replies sent', () => {
		page({ sent: [{ to: 'bob@outside.test', at: '2026-11-20T11:00:00Z', account: 'me@example.test' }] });
		expect(screen.getByText('bob@outside.test')).toBeTruthy();
		expect(screen.queryByText('None yet.')).toBeNull();
	});
});
