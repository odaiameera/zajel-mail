import Anthropic from '@anthropic-ai/sdk';
import { env } from '$env/dynamic/private';
import { agentModel, claudeClient, claudeConfigured, claudeError, writerModel } from './claude';
import { aiEndpoint, aiModel, aiProvider, listAvailableModels, upstreamErrorMessage } from './mail-assistant';
import { logEvent } from '$lib/server/log';

/**
 * Which AI the server is set up with, for Settings → Agent, and a check that
 * the key and models work. The check only asks the provider about the models,
 * so it runs nothing and costs nothing.
 */

export interface AssistantStatus {
	provider: 'anthropic' | 'openai' | 'ollama' | null;
	agentModel: string | null;
	writerModel: string | null;
}

export function assistantStatus(): AssistantStatus {
	if (claudeConfigured()) return { provider: 'anthropic', agentModel: agentModel(), writerModel: writerModel() };
	const provider = aiProvider();
	if (!provider) return { provider: null, agentModel: null, writerModel: null };
	// OpenAI and Ollama use one model for everything.
	return { provider, agentModel: aiModel(), writerModel: aiModel() };
}

async function checkClaude(models: string[]): Promise<string | null> {
	for (const model of new Set(models)) {
		try {
			await claudeClient().models.retrieve(model);
		} catch (err) {
			const failure = claudeError(err);
			// Name the model, since either of the two variables can be the wrong one.
			return err instanceof Anthropic.NotFoundError ? `This key can't use ${model}` : failure.message;
		}
	}
	return null;
}

async function checkOpenAI(model: string): Promise<string | null> {
	const response = await fetch(`${aiEndpoint()}/models/${encodeURIComponent(model)}`, {
		headers: { Authorization: `Bearer ${env.OPENAI_API_KEY ?? ''}` },
		signal: AbortSignal.timeout(10_000)
	}).catch(() => null);
	if (!response) return 'Could not reach the assistant';
	return response.ok ? null : upstreamErrorMessage(response.status);
}

async function checkOllama(model: string): Promise<string | null> {
	const served = await listAvailableModels();
	if (!served.length) return 'Could not reach the assistant';
	return served.includes(model) ? null : `The AI service does not serve ${model}`;
}

export async function checkAssistant(): Promise<{ ok: boolean; error?: string }> {
	const status = assistantStatus();
	const error =
		status.provider === 'anthropic'
			? await checkClaude([status.agentModel!, status.writerModel!])
			: status.provider === 'openai'
				? await checkOpenAI(status.agentModel!)
				: status.provider === 'ollama'
					? await checkOllama(status.agentModel!)
					: 'No AI provider is set up';
	logEvent(error ? 'warn' : 'info', 'ai', 'check', { provider: status.provider, ...(error ? { error } : {}) });
	return error ? { ok: false, error } : { ok: true };
}
