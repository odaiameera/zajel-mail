import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { isHttpError } from '@sveltejs/kit';

const env = vi.hoisted(() => ({}) as Record<string, string | undefined>);
vi.mock('$env/dynamic/private', () => ({ env }));

import { getDb } from '$lib/server/db/index';
import { runMigrations } from '$lib/server/db/migrate';
import { aiSettings, forgetAiSettingsForTests } from '$lib/server/ai/settings';
import { PUT } from './+server';

const user = { id: 'u1', email: 'me@example.test' };

async function put(body: Record<string, unknown>, verified = true) {
	try {
		const res = await PUT({
			locals: { user, sessionVerifiedAt: verified ? Date.now() : null },
			request: new Request('http://localhost/api/agent/assistant', { method: 'PUT', body: JSON.stringify(body) }),
			url: new URL('http://localhost/api/agent/assistant')
		} as unknown as Parameters<typeof PUT>[0]);
		return { status: res.status, body: await res.json() };
	} catch (thrown) {
		if (isHttpError(thrown)) return { status: thrown.status, body: thrown.body };
		throw thrown;
	}
}

beforeAll(() => runMigrations());

beforeEach(() => {
	for (const key of Object.keys(env)) delete env[key];
	env.ANTHROPIC_API_KEY = 'sk-ant';
	env.OLLAMA_URL = 'http://ollama:11434';
	getDb().exec('DELETE FROM ai_settings');
	forgetAiSettingsForTests();
});

describe('PUT /api/agent/assistant', () => {
	it('needs a fresh re-check, since the provider decides where mail goes', async () => {
		const res = await put({ provider: 'ollama' }, false);
		expect(res.status).toBe(403);
		expect(res.body.stepUp).toBe(true);
		expect(aiSettings().provider).toBeNull();
	});

	it('switches provider and answers with the new status', async () => {
		const res = await put({ provider: 'ollama' });
		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({ provider: 'ollama', available: ['anthropic', 'ollama'] });
	});

	it('refuses a provider without a key, and model ids that are not ids', async () => {
		expect((await put({ provider: 'openai' })).status).toBe(400);
		expect((await put({ agentModel: 'claude"; DROP' })).status).toBe(400);
		expect((await put({ agentEffort: 'max' })).status).toBe(400);
	});

	it('refuses fields it doesn’t know', async () => {
		expect((await put({ provider: 'ollama', junk: 'x' })).status).toBe(400);
		expect(aiSettings().provider).toBeNull();
	});

	it('files a model change under the provider actually running, not a stale choice', async () => {
		await put({ provider: 'ollama' });
		// The Ollama endpoint goes away: Claude takes over again.
		delete env.OLLAMA_URL;
		const res = await put({ agentModel: 'claude-sonnet-5-5' });
		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({ provider: 'anthropic', agentModel: 'claude-sonnet-5-5' });
	});

	it('refuses model ids that would be path tricks', async () => {
		await put({ provider: 'ollama' });
		expect((await put({ model: '.' })).status).toBe(400);
		expect((await put({ model: '..' })).status).toBe(400);
		expect((await put({ model: 'library/qwen3:8b' })).status).toBe(200);
	});

	it('sets Claude models and effort, and the plain model for other providers', async () => {
		const claude = await put({ agentModel: 'claude-sonnet-5-5', agentEffort: 'high' });
		expect(claude.body).toMatchObject({ provider: 'anthropic', agentModel: 'claude-sonnet-5-5', agentEffort: 'high' });
		expect((await put({ model: 'qwen3:8b' })).status).toBe(400);
		await put({ provider: 'ollama' });
		const ollama = await put({ model: 'qwen3:8b' });
		expect(ollama.body).toMatchObject({ provider: 'ollama', agentModel: 'qwen3:8b' });
	});
});
