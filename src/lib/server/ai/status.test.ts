import { beforeEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({}) as Record<string, string | undefined>);
vi.mock('$env/dynamic/private', () => ({ env }));

const retrieve = vi.hoisted(() => vi.fn());
const create = vi.hoisted(() => vi.fn());
const list = vi.hoisted(() => vi.fn());
vi.mock('@anthropic-ai/sdk', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@anthropic-ai/sdk')>();
	// A subclass keeps the SDK's error classes, which are static members.
	class FakeAnthropic extends actual.default {
		override models = { retrieve, list } as unknown as InstanceType<typeof actual.default>['models'];
		override beta = { messages: { create } } as unknown as InstanceType<typeof actual.default>['beta'];
	}
	return { default: FakeAnthropic };
});

import Anthropic from '@anthropic-ai/sdk';
import { assistantStatus, checkAssistant, forgetProbeForTests, listModels } from './status';
import { forgetStrictRefusals } from '$lib/server/agent/runtime';

beforeEach(() => {
	for (const key of Object.keys(env)) delete env[key];
	retrieve.mockReset();
	create.mockReset();
	create.mockResolvedValue({ content: [], stop_reason: 'max_tokens' });
	forgetProbeForTests();
	forgetStrictRefusals();
});

describe('assistant status', () => {
	it('is off with no key', async () => {
		expect(assistantStatus()).toEqual({ provider: null, available: [], agentModel: null, writerModel: null, agentEffort: null });
		expect(await checkAssistant()).toEqual({ ok: false, error: 'No AI provider is set up' });
	});

	it('names Claude and both models', () => {
		env.ANTHROPIC_API_KEY = 'sk-ant-test';
		expect(assistantStatus()).toEqual({
			provider: 'anthropic',
			available: ['anthropic'],
			agentModel: 'claude-opus-5-5',
			writerModel: 'claude-haiku-5-5',
			agentEffort: 'medium'
		});
	});

	it('checks both Claude models, then sends the agent its real tools', async () => {
		env.ANTHROPIC_API_KEY = 'sk-ant-test';
		retrieve.mockResolvedValue({ id: 'ok' });
		expect(await checkAssistant()).toEqual({ ok: true });
		expect(retrieve.mock.calls.map((call) => call[0])).toEqual(['claude-opus-5-5', 'claude-haiku-5-5']);
		const params = create.mock.calls[0][0];
		expect(params.model).toBe('claude-opus-5-5');
		expect(params.output_config).toEqual({ effort: 'medium' });
		expect(params.tools.map((t: { name: string }) => t.name)).toContain('send_email');
		expect(params.tools.some((t: { strict?: boolean }) => t.strict)).toBe(true);
		// And a writing request, at the effort the writer sends.
		expect(create.mock.calls[1][0]).toMatchObject({ model: 'claude-haiku-5-5', output_config: { effort: 'low' } });
	});

	it('reuses a passing check for a while, so the button can’t run up a bill', async () => {
		env.ANTHROPIC_API_KEY = 'sk-ant-test';
		retrieve.mockResolvedValue({ id: 'ok' });
		await checkAssistant();
		await Promise.all([checkAssistant(), checkAssistant()]);
		expect(create).toHaveBeenCalledTimes(2);
	});

	it('names the writing model when it refuses the writer’s request', async () => {
		env.ANTHROPIC_API_KEY = 'sk-ant-test';
		retrieve.mockResolvedValue({ id: 'ok' });
		create
			.mockResolvedValueOnce({ content: [], stop_reason: 'max_tokens' })
			.mockRejectedValueOnce(
				new Anthropic.BadRequestError(
					400,
					{ type: 'error', error: { type: 'invalid_request_error', message: 'effort is not supported' } },
					'400',
					new Headers()
				)
			);
		const result = await checkAssistant();
		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/^claude-haiku-5-5: /);
	});

	it('says so when the agent’s tools are refused, in the API’s own words', async () => {
		env.ANTHROPIC_API_KEY = 'sk-ant-test';
		retrieve.mockResolvedValue({ id: 'ok' });
		create.mockRejectedValue(
			new Anthropic.BadRequestError(
				400,
				{ type: 'error', error: { type: 'invalid_request_error', message: 'Too many strict tools (22).' } },
				'400 {"type":"error"}',
				new Headers()
			)
		);
		expect(await checkAssistant()).toEqual({ ok: false, error: 'The agent’s tools were refused: Too many strict tools (22).' });
	});

	it('lists Claude models for the picker', async () => {
		env.ANTHROPIC_API_KEY = 'sk-ant-test';
		const effort = (supported: boolean) => ({ supported, low: { supported }, medium: { supported }, high: { supported } });
		list.mockImplementation(async function* () {
			yield { id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', capabilities: { effort: effort(true) } };
			// Refuses the effort level every call sends: not offered.
			yield { id: 'claude-haiku-4-5', display_name: 'Claude Haiku 4.5', capabilities: { effort: effort(false) } };
			yield { id: 'claude-haiku-5-5', display_name: 'Claude Haiku 5.5', capabilities: null };
		});
		expect(await listModels('anthropic')).toEqual([
			{ id: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
			{ id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5' }
		]);
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
