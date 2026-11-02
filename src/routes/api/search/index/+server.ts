import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listAccounts } from '$lib/server/auth/accounts';
import { stepUpRequired } from '$lib/server/auth/step-up';
import { aiSettings, MODEL_ID, saveAiSettings } from '$lib/server/ai/settings';
import { logEvent } from '$lib/server/log';
import { cleanEmbedUrl, embedSettings } from '$lib/server/search/embed';
import { indexStatus } from '$lib/server/search/status';
import { enabledIndexes, requeueFailed, setIndexEnabled } from '$lib/server/search/store';
import { forgetVectors } from '$lib/server/search/vectors';
import { kickIndexer } from '$lib/server/search/worker';

function overview(userId: string, activeAccountId: string | undefined) {
	const settings = embedSettings();
	return {
		url: settings?.url ?? null,
		model: settings?.model ?? null,
		accounts: listAccounts(userId).map((a) => ({
			id: a.id,
			email: a.email,
			isActive: a.id === activeAccountId,
			...indexStatus(a.id)
		}))
	};
}

/** Semantic search: the endpoint and model, and each of this login's linked accounts. */
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) error(401, 'Not signed in');
	return json(overview(locals.user.id, locals.activeAccountId));
};

/**
 * Choose the embedding endpoint and model. The endpoint decides where every
 * message's text is sent, so a change needs a fresh re-check. An empty value
 * goes back to EMBED_URL / EMBED_MODEL.
 */
export const PUT: RequestHandler = async ({ locals, request }) => {
	if (!locals.user) error(401, 'Not signed in');
	const refused = stepUpRequired(locals);
	if (refused) return refused;

	const body = (await request.json().catch(() => null)) as { url?: unknown; model?: unknown } | null;
	if (!body || typeof body !== 'object' || (body.url === undefined && body.model === undefined)) {
		error(400, 'Expected url or model');
	}
	const next = { ...aiSettings() };
	if (body.url !== undefined) {
		if (typeof body.url !== 'string') error(400, 'url must be text');
		const url = body.url.trim() ? cleanEmbedUrl(body.url) : null;
		if (body.url.trim() && !url) error(400, 'That isn’t an http or https address');
		next.embedUrl = url;
	}
	if (body.model !== undefined) {
		if (typeof body.model !== 'string') error(400, 'model must be text');
		const model = body.model.trim();
		if (model && !MODEL_ID.test(model)) error(400, 'That isn’t a model name');
		next.embedModel = model || null;
	}

	const before = embedSettings()?.url ?? null;
	saveAiSettings(next);
	logEvent('info', 'search', 'settings_changed', { changed: Object.keys(body).join(',') });
	// A new endpoint may take what the old one refused; a new model starts
	// each index over. The indexer sees both on this pass.
	if ((embedSettings()?.url ?? null) !== before) for (const index of enabledIndexes()) requeueFailed(index.accountId);
	kickIndexer();
	return json(overview(locals.user.id, locals.activeAccountId));
};

/** Switch one account's index on (indexing starts) or off (the index is deleted). */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) error(401, 'Not signed in');

	const body = (await request.json().catch(() => null)) as { accountId?: unknown; enabled?: unknown } | null;
	const accountId = typeof body?.accountId === 'string' ? body.accountId : '';
	if (!listAccounts(locals.user.id).some((a) => a.id === accountId)) {
		return json({ error: 'Unknown account' }, { status: 404 });
	}
	if (typeof body?.enabled !== 'boolean') {
		return json({ error: 'enabled must be true or false' }, { status: 400 });
	}
	// Indexing sends the account's mail to the embedding endpoint, which
	// only exists once Settings or EMBED_URL names one.
	if (body.enabled && !embedSettings()) {
		return json({ error: 'No embedding endpoint is set' }, { status: 409 });
	}

	setIndexEnabled(accountId, body.enabled);
	forgetVectors(accountId);
	if (body.enabled) kickIndexer();
	return json({ success: true, status: indexStatus(accountId) });
};
