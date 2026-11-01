import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { decidePendingAction } from '$lib/server/agent/actions';

/**
 * Confirm or cancel something the agent proposed (sending a message). Only a
 * click reaches this; the agent itself has no way to.
 */
export const POST: RequestHandler = async ({ locals, params, request }) => {
	if (!locals.user) error(401, 'Not signed in');
	const body = (await request.json().catch(() => null)) as { decision?: unknown } | null;
	if (body?.decision !== 'confirm' && body?.decision !== 'cancel') error(400, 'decision must be confirm or cancel');

	const result = await decidePendingAction(locals.user.id, params.id, body.decision);
	return json(
		result.status === 200 ? { success: true, message: result.message } : { error: result.message },
		{ status: result.status }
	);
};
