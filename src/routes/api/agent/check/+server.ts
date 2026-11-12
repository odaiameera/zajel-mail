import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { checkAssistant } from '$lib/server/ai/status';

/** Settings → Assistant → Check: does the server's AI key work with its models. */
export const POST: RequestHandler = async ({ locals }) => {
	if (!locals.user) error(401, 'Not signed in');
	return json(await checkAssistant());
};
