// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';

vi.mock('@simplewebauthn/browser', () => ({ startAuthentication: vi.fn() }));

import StepUpDialog from './StepUpDialog.svelte';
import { fetchWithStepUp } from '$lib/auth/step-up';

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let verified = false;
const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
	const url = String(input);
	if (url === '/api/auth/step-up' && (!init?.method || init.method === 'GET')) {
		return json({ passkey: false, totp: true, password: false });
	}
	if (url === '/api/auth/step-up') {
		const body = JSON.parse(String(init?.body));
		verified = body.code === '123456';
		return verified ? json({ success: true }) : json({ message: 'no' }, 401);
	}
	// The guarded route: refused until the session has re-checked.
	return verified ? json({ success: true }) : json({ error: 'Confirm it’s you', stepUp: true }, 403);
});

beforeEach(() => {
	verified = false;
	vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
	cleanup();
	fetchMock.mockClear();
	vi.unstubAllGlobals();
});

describe('re-check before a risky change', () => {
	it('asks for a code when refused, then sends the request again', async () => {
		render(StepUpDialog);
		const pending = fetchWithStepUp('/api/auth/passkeys/pk1', { method: 'DELETE' });

		const input = await screen.findByLabelText('Code');
		await fireEvent.input(input, { target: { value: '000000' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
		expect(await screen.findByText('That didn’t work')).toBeTruthy();

		await fireEvent.input(input, { target: { value: '123456' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

		const res = await pending;
		expect(res.status).toBe(200);
		const deletes = fetchMock.mock.calls.filter(([url]) => String(url) === '/api/auth/passkeys/pk1');
		expect(deletes).toHaveLength(2);
		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
	});

	it('gives the refusal back when cancelled, without retrying', async () => {
		render(StepUpDialog);
		const pending = fetchWithStepUp('/api/auth/passkeys/pk1', { method: 'DELETE' });
		await fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
		expect((await pending).status).toBe(403);
		expect(fetchMock.mock.calls.filter(([url]) => String(url) === '/api/auth/passkeys/pk1')).toHaveLength(1);
	});
});
