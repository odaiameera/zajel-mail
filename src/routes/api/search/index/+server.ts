import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listAccounts } from '$lib/server/auth/accounts';
import { embedSettings } from '$lib/server/search/embed';
import { indexStatus } from '$lib/server/search/status';
import { setIndexEnabled } from '$lib/server/search/store';
import { forgetVectors } from '$lib/server/search/vectors';
import { kickIndexer } from '$lib/server/search/worker';

/** Semantic search for each of this login's linked accounts. */
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) error(401, 'Not signed in');
	return json({
		model: embedSettings()?.model ?? null,
		accounts: listAccounts(locals.user.id).map((a) => ({
			id: a.id,
			email: a.email,
			isActive: a.id === locals.activeAccountId,
			...indexStatus(a.id)
		}))
	});
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
	// only exists once EMBED_URL names one.
	if (body.enabled && !embedSettings()) {
		return json({ error: 'EMBED_URL isn’t set on this server' }, { status: 409 });
	}

	setIndexEnabled(accountId, body.enabled);
	forgetVectors(accountId);
	if (body.enabled) kickIndexer();
	return json({ success: true, status: indexStatus(accountId) });
};
