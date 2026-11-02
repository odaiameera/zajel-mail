import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({ env: {} }));

import { claudeError } from './claude';

describe('claudeError', () => {
	it('marks what clears on its own as transient, and a bad key or model as not', () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const headers = new Headers();
		const transient = (err: unknown) => claudeError(err).transient;
		expect(transient(new Anthropic.RateLimitError(429, undefined, 'slow down', headers))).toBe(true);
		expect(transient(new Anthropic.InternalServerError(529, undefined, 'overloaded', headers))).toBe(true);
		expect(transient(new Anthropic.APIConnectionTimeoutError())).toBe(true);
		expect(transient(new Anthropic.APIConnectionError({ message: 'socket hang up' }))).toBe(true);
		expect(transient(new Anthropic.AuthenticationError(401, undefined, 'invalid x-api-key', headers))).toBe(false);
		expect(transient(new Anthropic.NotFoundError(404, undefined, 'model not found', headers))).toBe(false);
		expect(transient(new Anthropic.BadRequestError(400, undefined, 'bad request', headers))).toBe(false);
	});
});
