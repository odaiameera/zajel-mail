import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { dismissNote } from '$lib/server/rules/store';
import { refreshPipeline } from '$lib/server/mail-pipeline';

/**
 * The owner has read a rule's note ("Got it"). A note about a rule that
 * still runs goes; what is left of a rule that became a sender pin goes
 * with its note. A rule waiting to be rewritten is dealt with by rewriting
 * or deleting it, so there is nothing here to dismiss for one.
 */
export const POST: RequestHandler = async ({ params, locals }) => {
	if (!locals.auth || !locals.activeAccountId) return json({ error: 'Not authenticated' }, { status: 401 });
	const done = dismissNote(locals.activeAccountId, params.id);
	if (done === null) return json({ error: 'Rule not found' }, { status: 404 });
	if (done === 'nothing') {
		return json({ error: 'This rule has no note to dismiss. Rewrite it or delete it.' }, { status: 400 });
	}
	if (done === 'deleted') refreshPipeline();
	return json({ success: true, deleted: done === 'deleted' });
};
