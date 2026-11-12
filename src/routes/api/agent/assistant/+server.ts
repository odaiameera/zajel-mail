import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { stepUpRequired } from '$lib/server/auth/step-up';
import { assistantStatus } from '$lib/server/ai/status';
import {
	aiSettings,
	availableProviders,
	EFFORTS,
	MODEL_ID,
	saveAiSettings,
	type AiSettings,
	type Effort,
	type ProviderName
} from '$lib/server/ai/settings';
import { logEvent } from '$lib/server/log';

const FIELDS = new Set(['provider', 'agentModel', 'writerModel', 'agentEffort', 'model']);

/**
 * Settings → Assistant: choose the provider, its models and the agent's effort.
 * The provider decides where mail content is sent, so every change needs a
 * fresh re-check. The reply is the status as it now stands.
 */
export const PUT: RequestHandler = async ({ locals, request }) => {
	if (!locals.user) error(401, 'Not signed in');
	const refused = stepUpRequired(locals);
	if (refused) return refused;

	const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
	if (!body || typeof body !== 'object') error(400, 'Expected JSON');
	const unknown = Object.keys(body).filter((key) => !FIELDS.has(key));
	if (unknown.length) error(400, `Unknown setting: ${unknown.slice(0, 3).join(', ').slice(0, 80)}`);
	const next: AiSettings = { ...aiSettings() };
	const model = (key: string): string => {
		const value = body[key];
		if (typeof value !== 'string' || !MODEL_ID.test(value)) error(400, `${key} isn't a model id`);
		return value;
	};

	if (body.provider !== undefined) {
		if (!availableProviders().includes(body.provider as ProviderName)) error(400, 'That provider has no key on this server');
		next.provider = body.provider as ProviderName;
	}
	// Model fields belong to the provider in use after this change: the one
	// just chosen, or else the one actually running, which isn't the stored
	// choice when that provider has since lost its key.
	const provider = body.provider !== undefined ? next.provider : assistantStatus().provider;
	if (body.agentModel !== undefined || body.writerModel !== undefined || body.agentEffort !== undefined) {
		if (provider !== 'anthropic') error(400, 'Only Claude has separate agent and writing models');
		if (body.agentModel !== undefined) next.agentModel = model('agentModel');
		if (body.writerModel !== undefined) next.writerModel = model('writerModel');
		if (body.agentEffort !== undefined) {
			if (!EFFORTS.includes(body.agentEffort as Effort)) error(400, 'Effort must be low, medium or high');
			next.agentEffort = body.agentEffort as Effort;
		}
	}
	if (body.model !== undefined) {
		if (provider === 'openai') next.openaiModel = model('model');
		else if (provider === 'ollama') next.ollamaModel = model('model');
		else error(400, 'Claude takes agentModel and writerModel');
	}

	saveAiSettings(next);
	logEvent('info', 'ai', 'settings_changed', { changed: Object.keys(body).join(','), provider });
	return json(assistantStatus());
};
