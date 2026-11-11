// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';

vi.mock('$app/navigation', () => ({ invalidateAll: vi.fn() }));

import Page from './+page.svelte';

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
	render(Page, {
		props: { data: { autoReply: saved, status: 'Off', sent: [], multipleAccounts: false, ...over } } as never
	});

const status = () => screen.getByTestId('auto-reply-status').textContent?.replace(/\s+/g, ' ').trim();

describe('Settings → Auto-reply', () => {
	it('saves nothing until Save, then sends the whole form with the time zone', async () => {
		page();
		await fireEvent.input(screen.getByLabelText('Message'), { target: { value: 'Away this week.' } });
		await fireEvent.click(screen.getByRole('switch'));
		await fireEvent.input(screen.getByLabelText('Until'), { target: { value: '2026-11-28' } });
		expect(posted).toEqual([]);

		await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		await waitFor(() => expect(posted).toHaveLength(1));
		expect(posted[0]).toMatchObject({ enabled: true, body: 'Away this week.', until: '2026-11-28', from: '', subject: '' });
		expect(typeof posted[0].tz).toBe('string');
	});

	it('shows each status, and the new one after a save', async () => {
		for (const s of ['Off', 'On', 'Starts 20 Nov', 'On until 28 Nov', 'Ended 28 Nov']) {
			page({ status: s });
			expect(status()).toBe(`Status: ${s}`);
			cleanup();
		}
		answer = { status: 200, body: { success: true, status: 'On until 28 Nov' } };
		page({ autoReply: { ...saved, enabled: true, body: 'Away' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		await waitFor(() => expect(status()).toBe('Status: On until 28 Nov'));
	});

	it('won’t save an end date before the start date', async () => {
		page({ autoReply: { ...saved, enabled: true, body: 'Away' } });
		await fireEvent.input(screen.getByLabelText('From'), { target: { value: '2026-11-21' } });
		await fireEvent.input(screen.getByLabelText('Until'), { target: { value: '2026-11-20' } });
		expect(screen.getByText('The end date is before the start date.')).toBeTruthy();
		const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
		expect(save.disabled).toBe(true);
		await fireEvent.click(save);
		expect(posted).toEqual([]);

		await fireEvent.input(screen.getByLabelText('Until'), { target: { value: '2026-11-21' } });
		expect(save.disabled).toBe(false);
	});

	it('shows what the server refused', async () => {
		answer = { status: 400, body: { error: 'The start date isn’t a date.' } };
		page({ autoReply: { ...saved, enabled: true, body: 'Away' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		expect(await screen.findByText('The start date isn’t a date.')).toBeTruthy();
	});

	it('lists the replies sent', () => {
		page({ sent: [{ to: 'bob@outside.test', at: '2026-11-20T11:00:00Z', account: 'me@example.test' }] });
		expect(screen.getByText('bob@outside.test')).toBeTruthy();
		expect(screen.queryByText('None yet.')).toBeNull();
	});
});
