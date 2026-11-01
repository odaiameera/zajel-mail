import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { decidePendingAction, STEP_UP_KINDS } from '$lib/server/agent/actions';
import { getPendingAction } from '$lib/server/agent/store';
import { stepUpRequired } from '$lib/server/auth/step-up';

/**
 * Confirm or cancel something the agent proposed (sending, invitations, a
 * delete, a job). Only a click reaches this; the agent itself has no way to.
 */
export const POST: RequestHandler = async ({ locals, params, request }) => {
	if (!locals.user) error(401, 'Not signed in');
	const body = (await request.json().catch(() => null)) as { decision?: unknown } | null;
	if (body?.decision !== 'confirm' && body?.decision !== 'cancel') error(400, 'decision must be confirm or cancel');

	// A job keeps running without anyone watching: confirming one needs a
	// fresh re-check, as other lasting changes do.
	if (body.decision === 'confirm') {
		const action = getPendingAction(locals.user.id, params.id);
		if (action && STEP_UP_KINDS.has(action.kind)) {
			const refused = stepUpRequired(locals);
			if (refused) return refused;
		}
	}

	const result = await decidePendingAction(locals.user.id, params.id, body.decision);
	return json(
		result.status === 200 ? { success: true, message: result.message } : { error: result.message },
		{ status: result.status }
	);
};
