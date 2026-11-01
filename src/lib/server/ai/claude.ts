import Anthropic from '@anthropic-ai/sdk';
import { env } from '$env/dynamic/private';
import { MailAssistantError, type AIChatMessage } from './mail-assistant';

/**
 * Claude through the Anthropic SDK. Two models with two jobs:
 *
 * - the agent (`ANTHROPIC_MODEL`, Claude Opus 5.5 by default) plans and
 *   uses tools;
 * - the writer (`ANTHROPIC_FAST_MODEL`, Claude Haiku 5.5 by default) does
 *   summaries, drafts, digests and extraction.
 *
 * Claude takes over every AI feature once `ANTHROPIC_API_KEY` is set, unless
 * `AI_PROVIDER` names OpenAI or Ollama instead.
 */

export const DEFAULT_AGENT_MODEL = 'claude-opus-5-5';
export const DEFAULT_WRITER_MODEL = 'claude-haiku-5-5';

/** Opus 5.5 refusals fall back server-side to the model Anthropic recommends. */
export const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export function claudeConfigured(): boolean {
	if (!env.ANTHROPIC_API_KEY) return false;
	const pick = env.AI_PROVIDER?.trim().toLowerCase();
	return !pick || pick === 'anthropic' || pick === 'claude';
}

export function agentModel(): string {
	return env.ANTHROPIC_MODEL || DEFAULT_AGENT_MODEL;
}

export function writerModel(): string {
	return env.ANTHROPIC_FAST_MODEL || DEFAULT_WRITER_MODEL;
}

/** Only the Opus line takes `fallbacks`; Haiku has no server-side fallback. */
export function supportsFallbacks(model: string): boolean {
	return /^claude-(opus|fable|sonnet)-/.test(model);
}

let cached: { key: string; client: Anthropic } | null = null;

export function claudeClient(): Anthropic {
	const key = env.ANTHROPIC_API_KEY ?? '';
	if (!cached || cached.key !== key) {
		// Two retries cover 429s and 5xx; one turn of the agent can take a
		// while at Opus effort, so the timeout is generous but finite.
		cached = { key, client: new Anthropic({ apiKey: key, timeout: 90_000, maxRetries: 2 }) };
	}
	return cached.client;
}

/**
 * What the browser is told when Claude fails. The provider's own message goes
 * to the server log only, as with the other providers.
 */
export function claudeError(err: unknown): MailAssistantError {
	if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
		return new MailAssistantError('The AI service rejected its API key', 502);
	}
	if (err instanceof Anthropic.NotFoundError) {
		return new MailAssistantError('The AI service does not serve the configured model — check ANTHROPIC_MODEL', 502);
	}
	if (err instanceof Anthropic.RateLimitError) {
		return new MailAssistantError('The AI service is rate limiting this account — wait a moment and try again', 502);
	}
	if (err instanceof Anthropic.APIConnectionTimeoutError) {
		return new MailAssistantError('The assistant took too long to respond', 502);
	}
	if (err instanceof Anthropic.APIConnectionError) {
		return new MailAssistantError('Could not reach the assistant', 502);
	}
	if (err instanceof Anthropic.APIError) {
		console.warn(`[ai] Claude ${err.status}: ${err.message.slice(0, 300)}`);
		return new MailAssistantError(`The AI service returned an error (${err.status ?? 'unknown'})`, 502);
	}
	return new MailAssistantError('The assistant failed', 502);
}

/** The text of a reply, or a clear error when Claude declined or stopped short. */
export function replyText(message: Anthropic.Beta.BetaMessage): string {
	if (message.stop_reason === 'refusal') {
		throw new MailAssistantError('The assistant declined to answer that', 422);
	}
	const text = message.content
		.filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === 'text')
		.map((block) => block.text)
		.join('')
		.trim();
	if (!text) throw new MailAssistantError('The assistant returned an empty answer', 502);
	return text;
}

/**
 * Writing on the writer model, in the same shape as `runAIChat`: summaries,
 * answers about one email, drafts and extraction. With `format`, the schema
 * is given as an instruction; callers already parse the JSON out leniently.
 */
export async function runClaudeWriting(input: {
	system: string;
	messages: AIChatMessage[];
	format?: Record<string, unknown>;
}): Promise<string> {
	const system = input.format
		? `${input.system}\n\nReply with only a JSON object that matches this JSON Schema, and nothing else:\n${JSON.stringify(input.format)}`
		: input.system;
	let message: Anthropic.Beta.BetaMessage;
	try {
		message = await claudeClient().beta.messages.create({
			model: writerModel(),
			max_tokens: 16000,
			// Short, everyday writing: low effort keeps it quick and cheap.
			output_config: { effort: 'low' },
			system,
			messages: input.messages
		});
	} catch (err) {
		throw claudeError(err);
	}
	return replyText(message).slice(0, 12_000);
}
