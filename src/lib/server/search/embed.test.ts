import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({}) as Record<string, string | undefined>);
vi.mock('$env/dynamic/private', () => ({ env }));

import { getDb } from '$lib/server/db/index';
import { runMigrations } from '$lib/server/db/migrate';
import { aiSettings, forgetAiSettingsForTests, saveAiSettings } from '$lib/server/ai/settings';
import { cleanEmbedUrl, DEFAULT_EMBED_MODEL, embed, EmbedError, embedSettings, normalize, promptStyle } from './embed';
import { fakeOllama } from './__fixtures__/fakes';

beforeAll(() => runMigrations());

beforeEach(() => {
	for (const key of Object.keys(env)) delete env[key];
	getDb().exec('DELETE FROM ai_settings');
	forgetAiSettingsForTests();
});
afterEach(() => vi.unstubAllGlobals());

describe('embedSettings', () => {
	it('is off until EMBED_URL is set, and never borrows the chat endpoint', () => {
		env.OLLAMA_URL = 'https://ollama.com';
		expect(embedSettings()).toBeNull();
		env.EMBED_URL = 'http://ollama:11434/';
		expect(embedSettings()).toEqual({ url: 'http://ollama:11434', model: DEFAULT_EMBED_MODEL });
		env.EMBED_MODEL = 'bge-m3';
		expect(embedSettings()?.model).toBe('bge-m3');
	});

	it('takes Settings over the environment', () => {
		env.EMBED_URL = 'http://ollama:11434';
		env.EMBED_MODEL = 'bge-m3';
		saveAiSettings({ ...aiSettings(), embedUrl: 'http://10.0.0.5:11434', embedModel: 'qwen3-embedding:0.6b' });
		expect(embedSettings()).toEqual({ url: 'http://10.0.0.5:11434', model: 'qwen3-embedding:0.6b' });
		saveAiSettings({ ...aiSettings(), embedUrl: null, embedModel: null });
		expect(embedSettings()).toEqual({ url: 'http://ollama:11434', model: 'bge-m3' });
	});

	it('can be set in Settings alone, without EMBED_URL', () => {
		saveAiSettings({ ...aiSettings(), embedUrl: 'http://ollama:11434' });
		expect(embedSettings()).toEqual({ url: 'http://ollama:11434', model: DEFAULT_EMBED_MODEL });
	});
});

describe('cleanEmbedUrl', () => {
	it('keeps an http or https address, trailing slashes trimmed', () => {
		expect(cleanEmbedUrl(' http://host.docker.internal:11434/ ')).toBe('http://host.docker.internal:11434');
		expect(cleanEmbedUrl('https://ollama.example/proxy/')).toBe('https://ollama.example/proxy');
	});

	it('refuses other schemes, credentials, queries and junk', () => {
		for (const bad of ['file:///etc/passwd', 'ftp://x', 'http://user:pw@host', 'http://host/?a=1', 'http://host/#x', 'not a url', `http://h/${'a'.repeat(200)}`]) {
			expect(cleanEmbedUrl(bad)).toBeNull();
		}
	});
});

describe('promptStyle', () => {
	it('uses each known family’s retrieval prompts', () => {
		expect(promptStyle('embeddinggemma-2:270m').query('plumber quote')).toBe('task: search result | query: plumber quote');
		expect(promptStyle('embeddinggemma').document('Quote', 'From: a\nbody')).toBe('title: Quote | text: From: a\nbody');
		expect(promptStyle('embeddinggemma').document('', 'body')).toBe('title: none | text: body');
		expect(promptStyle('nomic-embed-text:v1.5').query('x')).toBe('search_query: x');
		expect(promptStyle('qwen3-embedding:0.6b').query('x')).toMatch(/^Instruct: .*\nQuery: x$/);
	});

	it('leaves unknown models alone, unless the prefixes are set', () => {
		expect(promptStyle('bge-m3').query('x')).toBe('x');
		expect(promptStyle('bge-m3').document('Subject', 'body')).toBe('Subject\nbody');
		env.EMBED_QUERY_PREFIX = 'query: ';
		env.EMBED_DOCUMENT_PREFIX = 'passage: ';
		expect(promptStyle('embeddinggemma').query('x')).toBe('query: x');
		expect(promptStyle('embeddinggemma').document('S', 'b')).toBe('passage: S\nb');
	});
});

describe('embed', () => {
	beforeEach(() => {
		env.EMBED_URL = 'http://ollama:11434';
		env.EMBED_MODEL = 'embeddinggemma-2:270m';
	});

	it('posts every input to /api/embed in one call and returns unit vectors', async () => {
		const ollama = fakeOllama();
		const spy = vi.fn(ollama.fetch);
		vi.stubGlobal('fetch', spy);
		const vectors = await embed(['flight to Amman', 'school homework'], 1000);
		expect(spy).toHaveBeenCalledTimes(1);
		const [url, init] = spy.mock.calls[0];
		expect(url).toBe('http://ollama:11434/api/embed');
		expect(JSON.parse(String(init?.body))).toMatchObject({ model: 'embeddinggemma-2:270m', input: ['flight to Amman', 'school homework'], truncate: true });
		expect(vectors).toHaveLength(2);
		for (const v of vectors) expect(v.reduce((sum, x) => sum + x * x, 0)).toBeCloseTo(1, 5);
	});

	it('reports an unreachable endpoint and an error status as EmbedError', async () => {
		const ollama = fakeOllama();
		vi.stubGlobal('fetch', ollama.fetch);
		ollama.failure = 'down';
		await expect(embed(['x'], 1000)).rejects.toThrow(EmbedError);
		ollama.failure = 404;
		await expect(embed(['x'], 1000)).rejects.toMatchObject({ name: 'EmbedError', status: 404 });
	});

	it('follows a redirect on the same host, and refuses one to another', async () => {
		const ollama = fakeOllama();
		vi.stubGlobal('fetch', ollama.fetch);
		ollama.redirectTo = 'http://ollama:11434/v1/api/embed';
		expect(await embed(['x'], 1000)).toHaveLength(1);
		expect(ollama.requests).toEqual([['x']]);
		ollama.redirectTo = 'http://elsewhere.example/api/embed';
		await expect(embed(['x'], 1000)).rejects.toThrow('Redirects to elsewhere.example');
		// Nothing was sent there.
		expect(ollama.requests).toEqual([['x']]);
	});

	it('refuses a reply that doesn’t hold one vector per input', async () => {
		vi.stubGlobal('fetch', async () => Response.json({ embeddings: [[1, 0]] }));
		await expect(embed(['a', 'b'], 1000)).rejects.toThrow('no embeddings');
		vi.stubGlobal('fetch', async () => Response.json({ embeddings: [[1, 0], [1, 0, 0]] }));
		await expect(embed(['a', 'b'], 1000)).rejects.toThrow('different sizes');
	});

	it('throws without EMBED_URL rather than sending mail anywhere', async () => {
		delete env.EMBED_URL;
		const spy = vi.fn();
		vi.stubGlobal('fetch', spy);
		await expect(embed(['x'], 1000)).rejects.toThrow('EMBED_URL');
		expect(spy).not.toHaveBeenCalled();
	});
});

describe('normalize', () => {
	it('scales to unit length and leaves a zero vector alone', () => {
		expect([...normalize([3, 4])]).toEqual([0.6000000238418579, 0.800000011920929]);
		expect([...normalize([0, 0])]).toEqual([0, 0]);
	});
});
