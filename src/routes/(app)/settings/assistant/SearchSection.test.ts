// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { get } from 'svelte/store';

vi.mock('$app/navigation', () => ({ invalidateAll: vi.fn(), beforeNavigate: () => {} }));
vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/settings/assistant') } }));

import Page from './SearchSection.svelte';
import Harness from '../SettingsHarness.svelte';
import { barShown, discardButton, saveButton as barSave } from '$lib/settings/save-bar.testing';
import { stepUpPrompt } from '$lib/auth/step-up';

const overview = {
	url: 'http://ollama:11434',
	model: 'embeddinggemma-2:270m',
	accounts: [
		{ id: 'acct-1', email: 'me@example.test', isActive: true, configured: true, enabled: false, ready: false, total: 0, indexed: 0, lastError: null }
	]
};

const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
const open = () => render(Harness, { props: { page: Page } as never });
const endpoint = async () => (await screen.findByLabelText('Ollama endpoint')) as HTMLInputElement;
const saveButton = () => barSave()!;
const writes = () =>
	fetchMock.mock.calls
		.filter(([, init]) => init?.method && init.method !== 'GET')
		.map(([url, init]) => ({ url, method: init?.method, body: JSON.parse(String(init?.body)) }));

beforeEach(() => {
	fetchMock.mockReset().mockImplementation(async () => Response.json(overview));
	vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe('Settings → Assistant: semantic search', () => {
	it('says that the endpoint receives mail text', async () => {
		render(Page);
		expect(await screen.findByText(/receives the text of every message it indexes/)).toBeTruthy();
	});

	it('shows the loaded endpoint and model with nothing to save', async () => {
		open();
		expect((await endpoint()).value).toBe('http://ollama:11434');
		expect((screen.getByLabelText('Embedding model') as HTMLInputElement).value).toBe('embeddinggemma-2:270m');
		expect(barShown()).toBe(false);
	});

	it('puts the loaded values back on Discard, and hides the bar for a change typed back', async () => {
		open();
		const field = await endpoint();
		await fireEvent.input(field, { target: { value: 'http://other:11434' } });
		await fireEvent.click(discardButton()!);
		expect(field.value).toBe('http://ollama:11434');
		expect(barShown()).toBe(false);

		await fireEvent.input(field, { target: { value: 'http://ollama:1143' } });
		expect(barShown()).toBe(true);
		await fireEvent.input(field, { target: { value: 'http://ollama:11434' } });
		expect(barShown()).toBe(false);
		expect(writes()).toEqual([]);
	});

	it('sends the endpoint only when Save is pressed, not on leaving the field', async () => {
		open();
		const field = await endpoint();
		await fireEvent.input(field, { target: { value: ' http://other:11434/ ' } });
		await fireEvent.blur(field);
		await fireEvent.keyDown(field, { key: 'Enter' });
		expect(writes()).toEqual([]);

		// The server tidies the address; the field then shows it as stored.
		fetchMock.mockImplementationOnce(async () => Response.json({ ...overview, url: 'http://other:11434' }));
		await fireEvent.click(saveButton());
		expect(await screen.findByText('Saved')).toBeTruthy();

		expect(writes()).toEqual([{ url: '/api/search/index', method: 'PUT', body: { url: ' http://other:11434/ ' } }]);
		expect(field.value).toBe('http://other:11434');
		expect(barSave()).toBeNull();
	});

	it('leaves the change unsaved, without an error, when the sign-in check is closed', async () => {
		open();
		const field = await endpoint();
		await fireEvent.input(field, { target: { value: 'http://other:11434' } });

		fetchMock.mockImplementationOnce(async () => Response.json({ stepUp: true, message: 'Confirm it’s you' }, { status: 403 }));
		await fireEvent.click(saveButton());
		// The "Confirm it's you" dialog is asked for; the person closes it.
		await vi.waitFor(() => expect(get(stepUpPrompt)).not.toBeNull());
		get(stepUpPrompt)!(false);

		await vi.waitFor(() => expect(saveButton().textContent?.trim()).toBe('Save'));
		expect(screen.getByText('Unsaved changes')).toBeTruthy();
		expect(screen.queryByText('Confirm it’s you')).toBeNull();
		expect(field.value).toBe('http://other:11434');
		expect(saveButton().disabled).toBe(false);
	});

	it('saves once the sign-in check has passed', async () => {
		open();
		await fireEvent.input(await endpoint(), { target: { value: 'http://other:11434' } });

		fetchMock.mockImplementationOnce(async () => Response.json({ stepUp: true }, { status: 403 }));
		fetchMock.mockImplementationOnce(async () => Response.json({ ...overview, url: 'http://other:11434' }));
		await fireEvent.click(saveButton());
		await vi.waitFor(() => expect(get(stepUpPrompt)).not.toBeNull());
		get(stepUpPrompt)!(true);

		expect(await screen.findByText('Saved')).toBeTruthy();
		expect(writes()).toHaveLength(2);
	});

	it('shows the server’s reason when it refuses the address, and keeps what was typed', async () => {
		open();
		const field = await endpoint();
		await fireEvent.input(field, { target: { value: 'ftp://nope' } });

		fetchMock.mockImplementationOnce(async () =>
			Response.json({ message: 'That isn’t an http or https address' }, { status: 400 })
		);
		await fireEvent.click(saveButton());

		expect(await screen.findByText('That isn’t an http or https address')).toBeTruthy();
		expect(field.value).toBe('ftp://nope');
		expect(saveButton().disabled).toBe(false);
	});

	it('still switches an account’s index on the moment its switch is pressed', async () => {
		open();
		await endpoint();
		await fireEvent.click(screen.getByRole('switch', { name: 'Index me@example.test' }));

		await vi.waitFor(() =>
			expect(writes()).toEqual([{ url: '/api/search/index', method: 'POST', body: { accountId: 'acct-1', enabled: true } }])
		);
	});
});
