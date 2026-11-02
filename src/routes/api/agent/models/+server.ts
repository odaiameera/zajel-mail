import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listModels } from '$lib/server/ai/status';
import { availableProviders, type ProviderName } from '$lib/server/ai/settings';

/** Settings → Agent: the models a provider offers this server's key, for its pickers. */
export const GET: RequestHandler = async ({ locals, url }) => {
	if (!locals.user) error(401, 'Not signed in');
	const provider = url.searchParams.get('provider') as ProviderName | null;
	if (!provider || !availableProviders().includes(provider)) error(400, 'That provider has no key on this server');
	try {
		return json({ models: await listModels(provider) });
	} catch {
		// The pickers still show the model in use; a list is a convenience.
		return json({ models: [] });
	}
};
