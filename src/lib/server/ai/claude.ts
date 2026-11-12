import Anthropic from '@anthropic-ai/sdk';
import { env } from '$env/dynamic/private';
import { MailAssistantError, type AIChatMessage } from './mail-assistant';
import { errorFields, logEvent } from '$lib/server/log';
import { aiSettings, chosenProvider, type Effort } from './settings';

/**
 * Claude through the Anthropic SDK. Two models with two jobs:
 *
 * - the agent (`ANTHROPIC_MODEL`, Claude Opus 5.5 by default) plans and
 *   uses tools;
 * - the writer (`ANTHROPIC_FAST_MODEL`, Claude Haiku 5.5 by default) does
 *   summaries, drafts, digests and extraction.
 *
 * Claude takes over every AI feature once `ANTHROPIC_API_KEY` is set, unless
 * another provider is chosen in Settings → Assistant or named by `AI_PROVIDER`.
 * Models and effort chosen in Settings win over their variables (settings.ts).
 */

export const DEFAULT_AGENT_MODEL = 'claude-opus-5-5';
export const DEFAULT_WRITER_MODEL = 'claude-haiku-5-5';

/** Opus 5.5 refusals fall back server-side to the model Anthropic recommends. */
export const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export function claudeConfigured(): boolean {
	if (!env.ANTHROPIC_API_KEY) return false;
	const chosen = chosenProvider();
	if (chosen) return chosen === 'anthropic';
	const pick = env.AI_PROVIDER?.trim().toLowerCase();
	return !pick || pick === 'anthropic' || pick === 'claude';
}

export function agentModel(): string {
	return aiSettings().agentModel || env.ANTHROPIC_MODEL || DEFAULT_AGENT_MODEL;
}

export function writerModel(): string {
	return aiSettings().writerModel || env.ANTHROPIC_FAST_MODEL || DEFAULT_WRITER_MODEL;
}

/** How hard the agent thinks before acting; writing always runs at low. */
export function agentEffort(): Effort {
	return aiSettings().agentEffort ?? 'medium';
}

/** Only the Opus line takes `fallbacks`; Haiku has no server-side fallback. */
export function supportsFallbacks(model: string): boolean {
	return /^claude-(opus|fable|sonnet)-/.test(model);
}

const DEFAULT_FALLBACK_MODEL = 'claude-sonnet-5-5';

/**
 * Where an agent turn goes when the agent model is overloaded or over its
 * own rate limit as the turn starts (`ANTHROPIC_FALLBACK_MODEL`). Server-side
 * `fallbacks` only cover refusals, never capacity.
 */
export function fallbackModel(): string {
	return env.ANTHROPIC_FALLBACK_MODEL || DEFAULT_FALLBACK_MODEL;
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

type ErrorBody = { message?: string; details?: { error_code?: string } };

/** The `error` object of the API's response body, when there was one. */
function errorBody(err: unknown): ErrorBody | undefined {
	return err instanceof Anthropic.APIError ? (err.error as { error?: ErrorBody } | undefined)?.error : undefined;
}

/**
 * A spend or billing limit rather than a rate limit: the tier's monthly cap
 * (a 429 with its own error code), a limit set in the Console (a 400), or no
 * credit left. The whole organisation is paused on every model until it
 * resets or is raised, so retrying or switching models can't help.
 */
export function usageLimitReached(err: unknown): boolean {
	if (!(err instanceof Anthropic.APIError)) return false;
	const body = errorBody(err);
	return (
		err.type === 'billing_error' ||
		body?.details?.error_code === 'enforced_spend_limit_reached' ||
		/reached your (specified )?(workspace )?API usage limits|credit balance is too low/i.test(body?.message ?? '')
	);
}

/** Down for this model alone (overloaded, failing, or over its own rate limit), so another model may still answer. */
export function modelUnavailable(err: unknown): boolean {
	if (usageLimitReached(err)) return false;
	return err instanceof Anthropic.InternalServerError || err instanceof Anthropic.RateLimitError;
}

/**
 * The event-log fields for a Claude failure. The error code and headers are
 * named on their own: the message holds the whole response body, and its
 * cut-off would drop them.
 */
export function claudeErrorFields(err: unknown): Record<string, unknown> {
	const fields = errorFields(err);
	if (!(err instanceof Anthropic.APIError)) return fields;
	const header = (name: string) => err.headers?.get(name) ?? undefined;
	return {
		...fields,
		apiErrorType: err.type ?? undefined,
		errorCode: errorBody(err)?.details?.error_code,
		retryAfter: header('retry-after'),
		requestsRemaining: header('anthropic-ratelimit-requests-remaining'),
		inputTokensRemaining: header('anthropic-ratelimit-input-tokens-remaining'),
		outputTokensRemaining: header('anthropic-ratelimit-output-tokens-remaining')
	};
}

function sentence(text: string): string {
	const trimmed = text.trim().slice(0, 300);
	return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/**
 * What the browser is told when Claude fails. The provider's own message goes
 * to the server log only, as with the other providers; a limit's message is
 * the exception, since it names the limit and when access returns. Rate
 * limits, overloads and network trouble are marked transient; a bad key or
 * model, or a spend limit (which lasts until it is lifted), is not, so a
 * scheduled job that hits one fails and says so.
 */
export function claudeError(err: unknown): MailAssistantError {
	logEvent('error', 'ai', 'claude_error', claudeErrorFields(err));
	const body = errorBody(err);
	if (usageLimitReached(err)) {
		// The tier's monthly cap lifts at the start of the next month (UTC);
		// a Console limit's own message says when it lifts.
		const now = new Date();
		const resets =
			body?.details?.error_code === 'enforced_spend_limit_reached' && !/regain access/i.test(body.message ?? '')
				? ` Access returns on ${new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString().slice(0, 10)} (UTC) unless the limit is raised.`
				: '';
		return new MailAssistantError(
			`Anthropic has paused this API key: ${sentence(body?.message || 'its usage limit is reached')}${resets} Fix it under Billing or Limits at platform.claude.com.`,
			502
		);
	}
	if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
		return new MailAssistantError('The AI service rejected its API key', 502);
	}
	if (err instanceof Anthropic.NotFoundError) {
		return new MailAssistantError('The AI service does not serve the configured model — choose another in Settings → Assistant', 502);
	}
	if (err instanceof Anthropic.RateLimitError) {
		// The first sentence names the limit (requests, input or output tokens per minute).
		const limit = body?.message?.split(/(?<=\.)\s/)[0]?.replace(/\.$/, '').slice(0, 200);
		const wait = Number(err.headers?.get('retry-after'));
		return new MailAssistantError(
			`The AI service is rate limiting this account${limit ? `: ${limit}` : ''} — ${
				wait > 0 ? `try again in ${Math.ceil(wait)} s` : 'wait a moment and try again'
			}`,
			502,
			true
		);
	}
	// An abort is the turn's own deadline running out, retries included.
	if (err instanceof Anthropic.APIConnectionTimeoutError || err instanceof Anthropic.APIUserAbortError) {
		return new MailAssistantError('The assistant took too long to respond', 502, true);
	}
	if (err instanceof Anthropic.APIConnectionError) {
		return new MailAssistantError('Could not reach the assistant', 502, true);
	}
	if (err instanceof Anthropic.APIError && (err.status === 529 || err.type === 'overloaded_error')) {
		return new MailAssistantError('Claude is overloaded right now — try again in a few minutes', 502, true);
	}
	if (err instanceof Anthropic.APIError) {
		console.warn(`[ai] Claude ${err.status}: ${err.message.slice(0, 300)}`);
		return new MailAssistantError(`The AI service returned an error (${err.status ?? 'unknown'})`, 502, (err.status ?? 0) >= 500);
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

// The agent's compose tools write through here inside a turn, and a tool
// gets 60 s (TOOL_TIMEOUT_MS in agent/runtime.ts). Two tries of 25 s and the
// backoff between them finish inside that, so a slow first try can't leave a
// draft or a send card appearing after the tool already reported a timeout.
const WRITER_REQUEST = { timeout: 25_000, maxRetries: 1 };

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
		}, WRITER_REQUEST);
	} catch (err) {
		throw claudeError(err);
	}
	return replyText(message).slice(0, 12_000);
}
