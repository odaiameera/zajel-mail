import Anthropic from '@anthropic-ai/sdk';
import { env } from '$env/dynamic/private';
import {
	agentEffort,
	agentModel,
	claudeClient,
	claudeConfigured,
	claudeError,
	FALLBACK_BETA,
	fallbackModel,
	supportsFallbacks,
	writerModel
} from './claude';
import { aiModel, aiProvider, listAvailableModels, MailAssistantError, runAIChat, upstreamErrorMessage } from './mail-assistant';
import { availableProviders, type Effort, type ProviderName } from './settings';
import { schemasRefused, sendWithStrictFallback } from '$lib/server/agent/runtime';
import { toolsFor } from '$lib/server/agent/tools';
import { logEvent } from '$lib/server/log';

/**
 * Which AI the server is using, for Settings → Agent; the models each
 * provider offers, for its pickers; and a check that the setup works.
 */

export interface AssistantStatus {
	/** The provider in use. */
	provider: ProviderName | null;
	/** Providers with a key on this server, the ones that can be chosen. */
	available: ProviderName[];
	agentModel: string | null;
	writerModel: string | null;
	/** Claude only. */
	agentEffort: Effort | null;
}

export function assistantStatus(): AssistantStatus {
	const available = availableProviders();
	if (claudeConfigured()) {
		return { provider: 'anthropic', available, agentModel: agentModel(), writerModel: writerModel(), agentEffort: agentEffort() };
	}
	const provider = aiProvider();
	if (!provider) return { provider: null, available, agentModel: null, writerModel: null, agentEffort: null };
	// OpenAI and Ollama use one model for everything.
	return { provider, available, agentModel: aiModel(), writerModel: aiModel(), agentEffort: null };
}

export interface ModelOption {
	id: string;
	name: string;
}

// OpenAI lists every model it has; only the chat ones belong in the picker.
const OPENAI_CHAT = /^(gpt-|o\d)/;
const OPENAI_NOT_CHAT = /(audio|realtime|image|tts|transcribe|embedding|search|moderation)/;

/** The models a provider offers this key. Asking costs nothing. */
export async function listModels(provider: ProviderName): Promise<ModelOption[]> {
	if (provider === 'anthropic') {
		const models: ModelOption[] = [];
		for await (const model of claudeClient().models.list({ limit: 100 })) {
			// Every agent and writing call sends an effort level, which some older
			// models refuse; only list the ones that take it.
			const effort = model.capabilities?.effort;
			if (!model.id.startsWith('claude-') || (effort && !(effort.supported && effort.low.supported))) continue;
			models.push({ id: model.id, name: model.display_name || model.id });
		}
		return models;
	}
	if (provider === 'openai') {
		const response = await fetch('https://api.openai.com/v1/models', {
			headers: { Authorization: `Bearer ${env.OPENAI_API_KEY ?? ''}` },
			signal: AbortSignal.timeout(10_000)
		});
		if (!response.ok) throw new Error(upstreamErrorMessage(response.status));
		const data = (await response.json()) as { data?: { id: string }[] };
		return (data.data ?? [])
			.map((m) => m.id)
			.filter((id) => OPENAI_CHAT.test(id) && !OPENAI_NOT_CHAT.test(id))
			.sort((a, b) => b.localeCompare(a))
			.map((id) => ({ id, name: id }));
	}
	return (await listAvailableModels()).map((id) => ({ id, name: id }));
}

/** The API's own words for a refusal, without the status and JSON around them. */
function apiMessage(err: unknown): string {
	const body = (err as { error?: { error?: { message?: unknown } } }).error;
	const message = body?.error?.message;
	return (typeof message === 'string' ? message : err instanceof Error ? err.message : String(err)).slice(0, 300);
}

const PROBE = 'Reply with the single word OK.';

/**
 * The paid half of the Claude check: the agent's real request (its tools, as
 * strict as the agent sends them, at its effort) and a writing request (at
 * the writer's effort). The agent request is what failed in production while
 * a model lookup passed. Together they cost a few cents.
 */
async function probeClaude(): Promise<string | null> {
	const model = agentModel();
	try {
		await sendWithStrictFallback(
			toolsFor('chat'),
			(tools) =>
				claudeClient().beta.messages.create({
					model,
					max_tokens: 256,
					output_config: { effort: agentEffort() },
					system: [{ type: 'text', text: PROBE }],
					tools,
					messages: [{ role: 'user', content: PROBE }],
					...(supportsFallbacks(model) ? { betas: [FALLBACK_BETA], fallbacks: 'default' as const } : {})
				}),
			{ source: 'check', model }
		);
	} catch (err) {
		const failure = claudeError(err);
		return schemasRefused(err) ? `The agent’s tools were refused: ${apiMessage(err)}` : `${model}: ${failure.message}`;
	}
	const writer = writerModel();
	try {
		await claudeClient().beta.messages.create({
			model: writer,
			max_tokens: 64,
			output_config: { effort: 'low' },
			system: [{ type: 'text', text: PROBE }],
			messages: [{ role: 'user', content: PROBE }]
		});
	} catch (err) {
		return `${writer}: ${claudeError(err).message}`;
	}
	return null;
}


// A passing probe is reused for a while, and presses that overlap share one
// probe, so the button can't run up a bill.
const PROBE_REUSE_MS = 5 * 60_000;
let lastProbe: { key: string; at: number } | null = null;
let probing: { key: string; result: Promise<string | null> } | null = null;

/** For tests: forget the last probe. */
export function forgetProbeForTests(): void {
	lastProbe = null;
	probing = null;
}

/** Run `probe` for `key` unless it passed recently; overlapping presses share one run. */
async function probeOnce(key: string, probe: () => Promise<string | null>): Promise<string | null> {
	if (lastProbe?.key === key && Date.now() - lastProbe.at < PROBE_REUSE_MS) return null;
	if (probing?.key !== key) {
		const result = probe().finally(() => {
			probing = null;
		});
		probing = { key, result };
	}
	const error = await probing!.result;
	if (!error) lastProbe = { key, at: Date.now() };
	return error;
}

/**
 * Claude: every model in use must be available to the key (free), and then
 * the real requests must be accepted (probeClaude).
 */
async function checkClaude(models: string[]): Promise<string | null> {
	for (const model of new Set(models)) {
		try {
			await claudeClient().models.retrieve(model);
		} catch (err) {
			const failure = claudeError(err);
			// Name the model, since any of them can be the wrong one.
			return err instanceof Anthropic.NotFoundError ? `This key can't use ${model}` : failure.message;
		}
	}
	return probeOnce(`anthropic|${models.join('|')}|${agentEffort()}`, probeClaude);
}

/**
 * OpenAI and Ollama: the same small chat request a turn would send, through
 * the same code, so a key that can list models but not use one, or a model
 * that refuses the request's shape, fails here and not in the first turn.
 */
async function probeChat(): Promise<string | null> {
	try {
		await runAIChat({ system: PROBE, messages: [{ role: 'user', content: PROBE }], temperature: 0 });
		return null;
	} catch (err) {
		return err instanceof MailAssistantError ? err.message : 'Could not reach the assistant';
	}
}

export async function checkAssistant(): Promise<{ ok: boolean; error?: string }> {
	const status = assistantStatus();
	// The fallback takes a turn when the agent model is down, so when the
	// operator named one it must work too.
	const claudeModels = [status.agentModel!, status.writerModel!, ...(env.ANTHROPIC_FALLBACK_MODEL ? [fallbackModel()] : [])];
	const error =
		status.provider === 'anthropic'
			? await checkClaude(claudeModels)
			: status.provider === 'openai' || status.provider === 'ollama'
				? await probeOnce(`${status.provider}|${status.agentModel}`, probeChat)
				: 'No AI provider is set up';
	logEvent(error ? 'warn' : 'info', 'ai', 'check', { provider: status.provider, ...(error ? { error } : {}) });
	return error ? { ok: false, error } : { ok: true };
}
