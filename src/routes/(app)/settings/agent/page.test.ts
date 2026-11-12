// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';

vi.mock('$app/navigation', () => ({ invalidateAll: vi.fn(), beforeNavigate: () => {} }));
vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/settings/agent') } }));

import Page from './+page.svelte';
import Harness from '../SettingsHarness.svelte';
import { barShown, discardButton, saveButton as barSave } from '$lib/settings/save-bar.testing';

const claude = {
	provider: 'anthropic',
	available: ['anthropic', 'openai'],
	agentModel: 'model-a',
	writerModel: 'model-b',
	agentEffort: 'medium'
};
const job = { id: 'job-1', title: 'Morning digest', what: 'Summarise new mail', when: 'Every day at 8', enabled: true, nextRunAt: null, lastRunAt: null, lastResult: null };

/** What GET /api/agent answers; a test changes it to describe another server. */
let assistant: Record<string, unknown>;
const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();

const open = () => render(Harness, { props: { page: Page } as never });
const select = async (label: string) => (await screen.findByLabelText(label)) as HTMLSelectElement;
const saveButton = () => barSave()!;
const writes = () =>
	fetchMock.mock.calls
		.filter(([, init]) => init?.method && init.method !== 'GET')
		.map(([url, init]) => ({ url, method: init?.method, body: JSON.parse(String(init?.body)) }));

beforeEach(() => {
	assistant = claude;
	fetchMock.mockReset().mockImplementation(async (url, init) => {
		if (url.startsWith('/api/agent/models')) {
			return Response.json({ models: [{ id: 'model-a', name: 'Model A' }, { id: 'model-b', name: 'Model B' }] });
		}
		if (url === '/api/agent/assistant') {
			// The server answers with the setup as it now stands.
			assistant = { ...assistant, ...JSON.parse(String(init?.body)) };
			return Response.json(assistant);
		}
		return Response.json({ assistant, paused: false, jobs: [job], activity: [] });
	});
	vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe('Settings → Agent', () => {
	it('sends a model choice only when Save is pressed, and only the model that changed', async () => {
		open();
		const model = await select('Agent model');
		await vi.waitFor(() => expect(model.options).toHaveLength(2));
		await fireEvent.change(model, { target: { value: 'model-b' } });
		await fireEvent.change(await select('Agent effort'), { target: { value: 'high' } });

		expect(writes()).toEqual([]);
		expect(screen.getByText('Unsaved changes')).toBeTruthy();

		await fireEvent.click(saveButton());
		expect(await screen.findByText('Saved')).toBeTruthy();
		expect(writes()).toEqual([
			{ url: '/api/agent/assistant', method: 'PUT', body: { agentModel: 'model-b', agentEffort: 'high' } }
		]);
		expect(barSave()).toBeNull();
	});

	it('keeps the choice and shows the server’s reason when it refuses it', async () => {
		open();
		const model = await select('Agent model');
		await vi.waitFor(() => expect(model.options).toHaveLength(2));
		fetchMock.mockImplementationOnce(async () => Response.json({ message: 'agentModel isn’t a model id' }, { status: 400 }));
		await fireEvent.change(model, { target: { value: 'model-b' } });
		await fireEvent.click(saveButton());

		expect(await screen.findByText('agentModel isn’t a model id')).toBeTruthy();
		expect(model.value).toBe('model-b');
		expect(saveButton().disabled).toBe(false);
	});

	it('hides the bar when a choice is put back by hand', async () => {
		open();
		const effort = await select('Agent effort');
		await fireEvent.change(effort, { target: { value: 'low' } });
		expect(barShown()).toBe(true);
		await fireEvent.change(effort, { target: { value: 'medium' } });
		expect(barShown()).toBe(false);
		expect(writes()).toEqual([]);
	});

	it('saves a new provider on its own, and offers its models once it is in use', async () => {
		open();
		const model = await select('Agent model');
		await vi.waitFor(() => expect(model.options).toHaveLength(2));
		// A model picked for the old provider doesn't travel to the new one.
		await fireEvent.change(model, { target: { value: 'model-b' } });
		await fireEvent.change(await select('Provider'), { target: { value: 'openai' } });

		expect(screen.queryByLabelText('Agent model')).toBeNull();
		expect(screen.getByText(/Save to switch to OpenAI/)).toBeTruthy();
		expect(writes()).toEqual([]);

		await fireEvent.click(saveButton());
		expect(await screen.findByText('Saved')).toBeTruthy();
		expect(writes()).toEqual([{ url: '/api/agent/assistant', method: 'PUT', body: { provider: 'openai' } }]);
		// One model for everything, under the new provider.
		expect(await select('Model')).toBeTruthy();
		expect(screen.queryByText(/Save to switch/)).toBeNull();
	});

	it('goes back to the provider in use, and its models, on Discard', async () => {
		open();
		await fireEvent.change(await select('Provider'), { target: { value: 'openai' } });
		await fireEvent.click(discardButton()!);

		expect((await select('Provider')).value).toBe('anthropic');
		expect((await select('Agent model')).value).toBe('model-a');
		expect(writes()).toEqual([]);
	});

	it('still switches a job the moment it is pressed, without touching a choice waiting for Save', async () => {
		open();
		const model = await select('Agent model');
		await vi.waitFor(() => expect(model.options).toHaveLength(2));
		await fireEvent.change(model, { target: { value: 'model-b' } });

		await fireEvent.click(screen.getByRole('switch', { name: 'Run Morning digest' }));
		await vi.waitFor(() =>
			expect(writes()).toEqual([{ url: '/api/agent', method: 'PATCH', body: { id: 'job-1', enabled: false } }])
		);

		// The job change reloads the page's data; the pending model is still there.
		await vi.waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => url === '/api/agent')).toHaveLength(3));
		expect(model.value).toBe('model-b');
		expect(saveButton().disabled).toBe(false);
	});

	it('has no Save bar when the server has no provider to choose', async () => {
		assistant = { provider: null, available: [], agentModel: null, writerModel: null, agentEffort: null };
		open();
		expect(await screen.findByText('Morning digest')).toBeTruthy();
		expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
	});
});
