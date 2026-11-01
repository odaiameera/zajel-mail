import { beforeEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({}) as Record<string, string | undefined>);
vi.mock('$env/dynamic/private', () => ({ env }));

const create = vi.hoisted(() => vi.fn());
vi.mock('@anthropic-ai/sdk', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@anthropic-ai/sdk')>();
	class FakeAnthropic {
		beta = { messages: { create } };
	}
	Object.assign(FakeAnthropic, actual.default);
	return { default: FakeAnthropic };
});

import { agentModel, claudeConfigured, runClaudeWriting, writerModel } from './claude';
import { assistantConfigured } from './chat';

beforeEach(() => {
	for (const key of Object.keys(env)) delete env[key];
	create.mockReset();
});

describe('Claude configuration', () => {
	it('takes over once a key is set, unless AI_PROVIDER names another provider', () => {
		expect(claudeConfigured()).toBe(false);
		env.ANTHROPIC_API_KEY = 'sk-ant-test';
		expect(claudeConfigured()).toBe(true);
		expect(assistantConfigured()).toBe(true);
		env.AI_PROVIDER = 'openai';
		expect(claudeConfigured()).toBe(false);
		env.AI_PROVIDER = 'Anthropic';
		expect(claudeConfigured()).toBe(true);
	});

	it('uses Opus 5.5 for the agent and Haiku 5.5 for writing, unless overridden', () => {
		expect(agentModel()).toBe('claude-opus-5-5');
		expect(writerModel()).toBe('claude-haiku-5-5');
		env.ANTHROPIC_MODEL = 'claude-sonnet-5-5';
		env.ANTHROPIC_FAST_MODEL = 'claude-haiku-4-5';
		expect(agentModel()).toBe('claude-sonnet-5-5');
		expect(writerModel()).toBe('claude-haiku-4-5');
	});
});

describe('runClaudeWriting', () => {
	it('writes on the writer model at low effort, with no fallback', async () => {
		env.ANTHROPIC_API_KEY = 'sk-ant-test';
		create.mockResolvedValue({ stop_reason: 'end_turn', content: [{ type: 'text', text: ' A summary. ' }] });
		const text = await runClaudeWriting({ system: 'Summarize', messages: [{ role: 'user', content: 'email' }] });
		expect(text).toBe('A summary.');
		const params = create.mock.calls[0][0];
		expect(params).toMatchObject({ model: 'claude-haiku-5-5', output_config: { effort: 'low' }, system: 'Summarize' });
		expect(params.fallbacks).toBeUndefined();
	});

	it('puts a JSON schema into the instructions', async () => {
		env.ANTHROPIC_API_KEY = 'sk-ant-test';
		create.mockResolvedValue({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"found":false}' }] });
		await runClaudeWriting({ system: 'Extract', messages: [{ role: 'user', content: 'x' }], format: { type: 'object' } });
		expect(create.mock.calls[0][0].system).toContain('{"type":"object"}');
	});

	it('reports a refusal instead of an empty answer', async () => {
		env.ANTHROPIC_API_KEY = 'sk-ant-test';
		create.mockResolvedValue({ stop_reason: 'refusal', content: [] });
		await expect(runClaudeWriting({ system: 's', messages: [{ role: 'user', content: 'x' }] })).rejects.toMatchObject({
			message: 'The assistant declined to answer that',
			status: 422
		});
	});
});
