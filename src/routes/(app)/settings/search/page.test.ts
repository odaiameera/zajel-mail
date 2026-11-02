// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/svelte';

import Page from './+page.svelte';

const overview = {
	url: 'http://ollama:11434',
	model: 'embeddinggemma-2:270m',
	accounts: [
		{ id: 'acct-1', email: 'me@example.test', isActive: true, configured: true, enabled: false, ready: false, total: 0, indexed: 0, lastError: null }
	]
};

beforeEach(() => {
	vi.stubGlobal('fetch', vi.fn(async () => Response.json(overview)));
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe('Settings → Search', () => {
	it('says where the endpoint is reached from, and that it receives mail text', async () => {
		render(Page);
		expect(await screen.findByText(/Reached from the server, not your browser/)).toBeTruthy();
		expect(screen.getByText(/receives the text of every message it indexes/)).toBeTruthy();
	});
});
