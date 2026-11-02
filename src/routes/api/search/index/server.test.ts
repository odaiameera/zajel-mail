import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { isHttpError } from '@sveltejs/kit';

const env = vi.hoisted(() => ({}) as Record<string, string | undefined>);
vi.mock('$env/dynamic/private', () => ({ env }));
const mocks = vi.hoisted(() => ({ kickIndexer: vi.fn(), logEvent: vi.fn() }));
vi.mock('$lib/server/search/worker', () => ({ kickIndexer: mocks.kickIndexer }));
vi.mock('$lib/server/log', () => ({ logEvent: mocks.logEvent, errorFields: () => ({}) }));
vi.mock('$lib/server/auth/accounts', () => ({ listAccounts: () => [{ id: 'acct-1', email: 'me@example.test' }] }));

import { getDb } from '$lib/server/db/index';
import { runMigrations } from '$lib/server/db/migrate';
import { aiSettings, forgetAiSettingsForTests } from '$lib/server/ai/settings';
import { getIndexState, indexProgress, recordAttempt, updateIndexState, upsertEmails } from '$lib/server/search/store';
import { GET, POST, PUT } from './+server';

const user = { id: 'user-1', email: 'me@example.test' };

async function send(handler: typeof PUT, method: string, body?: Record<string, unknown>, verified = true) {
	try {
		const res = await handler({
			locals: { user, sessionVerifiedAt: verified ? Date.now() : null, activeAccountId: 'acct-1' },
			request: new Request('http://localhost/api/search/index', { method, body: body ? JSON.stringify(body) : undefined })
		} as unknown as Parameters<typeof PUT>[0]);
		return { status: res.status, body: await res.json() };
	} catch (thrown) {
		if (isHttpError(thrown)) return { status: thrown.status, body: thrown.body as unknown as Record<string, unknown> };
		throw thrown;
	}
}

beforeAll(() => {
	runMigrations();
	getDb().prepare(`INSERT INTO app_user (id, email, password_hash) VALUES ('user-1', 'me@example.test', 'x')`).run();
	getDb()
		.prepare(
			`INSERT INTO mail_accounts (id, user_id, email, server_url, jmap_account_id, secret_enc)
			 VALUES ('acct-1', 'user-1', 'me@example.test', 'https://mail.example', 'jmap', 'x')`
		)
		.run();
});

beforeEach(() => {
	for (const key of Object.keys(env)) delete env[key];
	getDb().exec('DELETE FROM ai_settings');
	forgetAiSettingsForTests();
	vi.clearAllMocks();
});

describe('PUT /api/search/index', () => {
	it('needs a fresh re-check, since the endpoint decides where mail goes', async () => {
		const res = await send(PUT, 'PUT', { url: 'http://ollama:11434' }, false);
		expect(res.status).toBe(403);
		expect(res.body.stepUp).toBe(true);
		expect(aiSettings().embedUrl).toBeNull();
	});

	it('saves the endpoint and model, and answers with what is now in effect', async () => {
		const res = await send(PUT, 'PUT', { url: 'http://host.docker.internal:11434/', model: 'bge-m3' });
		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({ url: 'http://host.docker.internal:11434', model: 'bge-m3' });
		expect(res.body.accounts[0]).toMatchObject({ id: 'acct-1', configured: true, enabled: false });
		expect(aiSettings()).toMatchObject({ embedUrl: 'http://host.docker.internal:11434', embedModel: 'bge-m3' });
		expect(mocks.kickIndexer).toHaveBeenCalled();
		expect(mocks.logEvent).toHaveBeenCalledWith('info', 'search', 'settings_changed', { changed: 'url,model' });
	});

	it('goes back to the environment when a field is emptied', async () => {
		env.EMBED_URL = 'http://ollama:11434';
		await send(PUT, 'PUT', { url: 'http://10.0.0.5:11434' });
		const res = await send(PUT, 'PUT', { url: '' });
		expect(res.body.url).toBe('http://ollama:11434');
		expect(aiSettings().embedUrl).toBeNull();
	});

	it('refuses an address or model name it can’t use', async () => {
		expect((await send(PUT, 'PUT', { url: 'file:///etc/passwd' })).status).toBe(400);
		expect((await send(PUT, 'PUT', { model: '../../x' })).status).toBe(400);
		expect((await send(PUT, 'PUT', {})).status).toBe(400);
		expect(aiSettings()).toMatchObject({ embedUrl: null, embedModel: null });
	});
});

describe('GET and POST /api/search/index', () => {
	it('can’t switch indexing on until an endpoint is set, then can', async () => {
		expect((await send(POST, 'POST', { accountId: 'acct-1', enabled: true })).status).toBe(409);
		await send(PUT, 'PUT', { url: 'http://ollama:11434' });
		expect((await send(POST, 'POST', { accountId: 'acct-1', enabled: true })).status).toBe(200);
		const overview = await send(GET, 'GET');
		expect(overview.body.accounts[0]).toMatchObject({ enabled: true, ready: false, total: 0 });
		await send(POST, 'POST', { accountId: 'acct-1', enabled: false });
	});

	it('refuses an account that isn’t this login’s', async () => {
		expect((await send(POST, 'POST', { accountId: 'acct-9', enabled: true })).status).toBe(404);
	});

	it('gives refused messages another chance when the endpoint changes', async () => {
		await send(PUT, 'PUT', { url: 'http://ollama:11434' });
		await send(POST, 'POST', { accountId: 'acct-1', enabled: true });
		upsertEmails('acct-1', [{ id: 'm1', receivedAt: '2026-01-01T00:00:00Z', mailboxIds: [] }], 0);
		for (let i = 0; i < 3; i++) recordAttempt('acct-1', 'm1');
		updateIndexState('acct-1', { listed: true, ready: true });
		expect(indexProgress('acct-1')).toMatchObject({ failed: 1, pending: 0 });

		// Another model starts over anyway; only another endpoint requeues.
		await send(PUT, 'PUT', { model: 'bge-m3' });
		expect(indexProgress('acct-1')).toMatchObject({ failed: 1, pending: 0 });
		await send(PUT, 'PUT', { url: 'http://10.0.0.5:11434' });
		expect(indexProgress('acct-1')).toMatchObject({ failed: 0, pending: 1 });
		expect(getIndexState('acct-1')?.ready).toBe(false);
		await send(POST, 'POST', { accountId: 'acct-1', enabled: false });
	});

	it('shows a finished index as ready, whatever went wrong on the way', async () => {
		await send(PUT, 'PUT', { url: 'http://ollama:11434' });
		await send(POST, 'POST', { accountId: 'acct-1', enabled: true });
		updateIndexState('acct-1', {
			model: 'embeddinggemma-2:270m', dimensions: 8, listed: true, ready: true, lastError: 'Unreachable: fetch failed'
		});
		const overview = await send(GET, 'GET');
		expect(overview.body.accounts[0]).toMatchObject({ ready: true, lastError: null });
		await send(POST, 'POST', { accountId: 'acct-1', enabled: false });
	});
});
