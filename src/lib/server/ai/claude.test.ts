import { beforeEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({}) as Record<string, string | undefined>);
vi.mock('$env/dynamic/private', () => ({ env }));

const create = vi.hoisted(() => vi.fn());
const logEvent = vi.hoisted(() => vi.fn());
vi.mock('@anthropic-ai/sdk', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@anthropic-ai/sdk')>();
	// A subclass keeps the SDK's error classes, which are static members.
	class FakeAnthropic extends actual.default {
		override beta = { messages: { create } } as unknown as InstanceType<typeof actual.default>['beta'];
	}
	return { default: FakeAnthropic };
});
vi.mock('$lib/server/log', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/log')>()),
	logEvent
}));

import Anthropic from '@anthropic-ai/sdk';
import {
	agentModel,
	claudeConfigured,
	claudeError,
	claudeErrorFields,
	fallbackModel,
	modelUnavailable,
	runClaudeWriting,
	usageLimitReached,
	writerModel
} from './claude';
import { assistantConfigured } from './chat';

beforeEach(() => {
	for (const key of Object.keys(env)) delete env[key];
	create.mockReset();
	logEvent.mockReset();
});

/** An error as the SDK builds it from a response: status, body and headers. */
function apiError(status: number, type: string, message: string, extra: { details?: object; headers?: Record<string, string> } = {}) {
	return Anthropic.APIError.generate(
		status,
		{ type: 'error', error: { type, message, ...(extra.details ? { details: extra.details } : {}) } },
		undefined,
		new Headers(extra.headers ?? {})
	);
}

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
		// Bounded well inside an agent turn, which calls it from its compose tool.
		expect(create.mock.calls[0][1]).toEqual({ timeout: 25_000, maxRetries: 1 });
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

describe('Claude failures', () => {
	const spendCap = () =>
		apiError(429, 'rate_limit_error', 'You have reached your monthly spend limit.', {
			details: { error_code: 'enforced_spend_limit_reached' }
		});
	const consoleLimit = () =>
		apiError(400, 'invalid_request_error', 'You have reached your specified API usage limits. You will regain access on 2026-12-01 at 00:00 UTC.');

	it('says the key is paused at a spend cap, when access returns, and where to fix it', () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date('2026-11-20T10:00:00Z'));
		try {
			expect(claudeError(spendCap()).message).toBe(
				'Anthropic has paused this API key: You have reached your monthly spend limit. Access returns on 2026-12-01 (UTC) unless the limit is raised. Fix it under Billing or Limits at platform.claude.com.'
			);
		} finally {
			vi.useRealTimers();
		}
		expect(claudeError(consoleLimit()).message).toBe(
			'Anthropic has paused this API key: You have reached your specified API usage limits. You will regain access on 2026-12-01 at 00:00 UTC. Fix it under Billing or Limits at platform.claude.com.'
		);
	});

	it('logs the error code and retry-after the message would cut off', () => {
		claudeError(spendCap());
		expect(logEvent).toHaveBeenCalledWith(
			'error',
			'ai',
			'claude_error',
			expect.objectContaining({ status: 429, apiErrorType: 'rate_limit_error', errorCode: 'enforced_spend_limit_reached' })
		);
		const limited = apiError(429, 'rate_limit_error', 'Too many tokens.', {
			headers: { 'retry-after': '12', 'anthropic-ratelimit-input-tokens-remaining': '0' }
		});
		expect(claudeErrorFields(limited)).toMatchObject({ retryAfter: '12', inputTokensRemaining: '0' });
	});

	it('names a rate limit and how long to wait', () => {
		const limited = apiError(
			429,
			'rate_limit_error',
			'This request would exceed the rate limit for your organization of 30,000 input tokens per minute. For details, refer to the docs.',
			{ headers: { 'retry-after': '12' } }
		);
		expect(claudeError(limited).message).toBe(
			'The AI service is rate limiting this account: This request would exceed the rate limit for your organization of 30,000 input tokens per minute — try again in 12 s'
		);
		expect(claudeError(apiError(429, 'rate_limit_error', '')).message).toBe(
			'The AI service is rate limiting this account — wait a moment and try again'
		);
	});

	it('says an overload is an overload', () => {
		expect(claudeError(apiError(529, 'overloaded_error', 'Overloaded')).message).toBe(
			'Claude is overloaded right now — try again in a few minutes'
		);
	});

	it('reports the turn deadline running out as taking too long', () => {
		expect(claudeError(new Anthropic.APIUserAbortError()).message).toBe('The assistant took too long to respond');
	});

	it('only treats an overload or a model rate limit as worth another model', () => {
		expect(modelUnavailable(apiError(529, 'overloaded_error', 'Overloaded'))).toBe(true);
		expect(modelUnavailable(apiError(500, 'api_error', 'Internal'))).toBe(true);
		expect(modelUnavailable(apiError(429, 'rate_limit_error', 'Too many requests.'))).toBe(true);
		// A spend limit pauses every model.
		expect(usageLimitReached(spendCap())).toBe(true);
		expect(modelUnavailable(spendCap())).toBe(false);
		expect(modelUnavailable(consoleLimit())).toBe(false);
		expect(modelUnavailable(apiError(400, 'invalid_request_error', 'Bad'))).toBe(false);
		expect(modelUnavailable(new Anthropic.APIUserAbortError())).toBe(false);
	});

	it('falls back to Sonnet 5.5 unless ANTHROPIC_FALLBACK_MODEL says otherwise', () => {
		expect(fallbackModel()).toBe('claude-sonnet-5-5');
		env.ANTHROPIC_FALLBACK_MODEL = 'claude-haiku-5-5';
		expect(fallbackModel()).toBe('claude-haiku-5-5');
	});
});
