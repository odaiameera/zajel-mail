import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({}) as Record<string, string | undefined>);
vi.mock('$env/dynamic/private', () => ({ env }));

import { askJev, costUsd, JevError, jevMode, jevModel } from './client';
import { CATEGORY_QUESTION } from './categorize';

const questions = { category: CATEGORY_QUESTION };
const okBody = {
	model: 'jev-1.13.0',
	answers: {
		category: {
			type: 'choice',
			choice: 'updates',
			probabilities: { important: 0.05, updates: 0.85, newsletters: 0.05, promotions: 0.05 },
			confidence: 0.8
		}
	},
	usage: { input_tokens: 812, output_tokens: 3 }
};

function reply(status: number, body: unknown, headers: Record<string, string> = {}) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json', ...headers }
	});
}

beforeEach(() => {
	for (const key of Object.keys(env)) delete env[key];
	env.TYPESAFE_API_KEY = 'ts-test-key';
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe('configuration', () => {
	it('is live with a key, mock when asked, and off otherwise', () => {
		expect(jevMode()).toBe('live');
		env.JEV_MOCK = '1';
		expect(jevMode()).toBe('mock');
		delete env.JEV_MOCK;
		delete env.TYPESAFE_API_KEY;
		expect(jevMode()).toBe('off');
	});

	it('pins a model version unless JEV_MODEL says otherwise', () => {
		expect(jevModel()).toBe('jev-1.13.0');
		env.JEV_MODEL = 'jev-1.14.0';
		expect(jevModel()).toBe('jev-1.14.0');
	});

	it('prices input tokens at $0.042 per million', () => {
		expect(costUsd(1_000_000)).toBeCloseTo(0.042);
	});
});

describe('askJev', () => {
	it('posts the state and questions with the key and reads the answers', async () => {
		const fetchMock = vi.fn().mockResolvedValue(reply(200, okBody));
		vi.stubGlobal('fetch', fetchMock);

		const state = { email: { subject: 'Your statement' }, facts: {} };
		const res = await askJev(state, questions);

		expect(res).toMatchObject({ model: 'jev-1.13.0', mock: false, usage: { inputTokens: 812, outputTokens: 3 } });
		expect(res.answers.category).toMatchObject({ choice: 'updates' });

		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe('https://api.typesafe.ai/v1/systemone');
		expect((init.headers as Record<string, string>).Authorization).toBe('Bearer ts-test-key');
		expect(JSON.parse(String(init.body))).toEqual({ model: 'jev-1.13.0', state, questions });
	});

	it('retries when rate limited, honouring retry-after', async () => {
		vi.useFakeTimers();
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(reply(429, {}, { 'retry-after': '2' }))
			.mockResolvedValueOnce(reply(529, {}))
			.mockResolvedValueOnce(reply(200, okBody));
		vi.stubGlobal('fetch', fetchMock);

		const pending = askJev({}, questions);
		await vi.advanceTimersByTimeAsync(2000); // retry-after
		await vi.advanceTimersByTimeAsync(1000); // second backoff step
		await expect(pending).resolves.toMatchObject({ model: 'jev-1.13.0' });
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it('gives up after the retries and keeps TypeSafe’s detail out of the message', async () => {
		vi.useFakeTimers();
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => reply(429, { secret: 'detail' })));

		const pending = askJev({}, questions).catch((err) => err);
		await vi.advanceTimersByTimeAsync(5000);
		const err = await pending;
		expect(err).toBeInstanceOf(JevError);
		expect(err.status).toBe(429);
		expect(err.message).not.toContain('detail');
	});

	it('names the key as the problem on a 401', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(401, { error: 'bad key' })));
		await expect(askJev({}, questions)).rejects.toThrow('TypeSafe rejected the API key');
	});

	it('carries TypeSafe’s own status, and none when it couldn’t be reached', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(400, { error: 'state too large' })));
		await expect(askJev({}, questions)).rejects.toMatchObject({ status: 502, upstream: 400 });
		vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
		await expect(askJev({}, questions)).rejects.toMatchObject({ status: 502, upstream: null });
	});

	it('refuses to run unconfigured, and never calls out in mock mode', async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);

		delete env.TYPESAFE_API_KEY;
		await expect(askJev({}, questions)).rejects.toMatchObject({ status: 501 });

		env.JEV_MOCK = '1';
		const res = await askJev({ email: { subject: 'Hi' }, facts: {} }, questions);
		expect(res.mock).toBe(true);
		expect(res.model).toBe('mock');
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
