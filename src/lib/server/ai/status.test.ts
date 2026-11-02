import { beforeEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({}) as Record<string, string | undefined>);
vi.mock('$env/dynamic/private', () => ({ env }));

const retrieve = vi.hoisted(() => vi.fn());
vi.mock('@anthropic-ai/sdk', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@anthropic-ai/sdk')>();
	// A subclass keeps the SDK's error classes, which are static members.
	class FakeAnthropic extends actual.default {
		override models = { retrieve } as unknown as InstanceType<typeof actual.default>['models'];
	}
	return { default: FakeAnthropic };
});

import Anthropic from '@anthropic-ai/sdk';
import { assistantStatus, checkAssistant } from './status';

beforeEach(() => {
	for (const key of Object.keys(env)) delete env[key];
	retrieve.mockReset();
});

describe('assistant status', () => {
	it('is off with no key', async () => {
		expect(assistantStatus()).toEqual({ provider: null, agentModel: null, writerModel: null });
		expect(await checkAssistant()).toEqual({ ok: false, error: 'No AI provider is set up' });
	});

	it('names Claude and both models', () => {
		env.ANTHROPIC_API_KEY = 'sk-ant-test';
		expect(assistantStatus()).toEqual({ provider: 'anthropic', agentModel: 'claude-opus-5-5', writerModel: 'claude-haiku-5-5' });
	});

	it('checks both Claude models without running either', async () => {
		env.ANTHROPIC_API_KEY = 'sk-ant-test';
		retrieve.mockResolvedValue({ id: 'ok' });
		expect(await checkAssistant()).toEqual({ ok: true });
		expect(retrieve.mock.calls.map((call) => call[0])).toEqual(['claude-opus-5-5', 'claude-haiku-5-5']);
	});

	it('names the model the key cannot use', async () => {
		env.ANTHROPIC_API_KEY = 'sk-ant-test';
		env.ANTHROPIC_FAST_MODEL = 'claude-haiku-9-9';
		retrieve.mockImplementation(async (model: string) => {
			if (model === 'claude-haiku-9-9') {
				throw new Anthropic.NotFoundError(404, { type: 'error', error: { type: 'not_found_error', message: 'model' } }, 'model', new Headers());
			}
			return { id: model };
		});
		expect(await checkAssistant()).toEqual({ ok: false, error: "This key can't use claude-haiku-9-9" });
	});

	it('reports a rejected key', async () => {
		env.ANTHROPIC_API_KEY = 'sk-ant-bad';
		retrieve.mockRejectedValue(
			new Anthropic.AuthenticationError(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, 'invalid', new Headers())
		);
		expect(await checkAssistant()).toEqual({ ok: false, error: 'The AI service rejected its API key' });
	});
});
