import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getScheduledSend } from '$lib/server/db/queries/scheduled-sends';
import { cancelScheduledSend, retryScheduledSend } from '$lib/server/scheduled-send';

/** When a message waiting in Scheduled goes out, or why it didn't. 404 once it's sent. */
export const GET: RequestHandler = async ({ locals, params }) => {
	if (!locals.auth || !locals.activeAccountId) return json({ error: 'Not authenticated' }, { status: 401 });
	const row = getScheduledSend(locals.activeAccountId, params.emailId);
	if (!row) return json({ error: 'Not scheduled' }, { status: 404 });
	return json({ emailId: row.jmap_email_id, sendAt: row.send_at, status: row.status, error: row.last_error });
};

/** `cancel` (the message moves to Drafts) or `retry` (a failed send, now). */
export const POST: RequestHandler = async ({ request, locals, params }) => {
	if (!locals.auth || !locals.activeAccountId) return json({ error: 'Not authenticated' }, { status: 401 });
	const { action } = (await request.json().catch(() => ({}))) as { action?: string };

	if (action === 'cancel') {
		try {
			const result = await cancelScheduledSend(locals.activeAccountId, locals.auth, params.emailId);
			const status = result.success
				? 200
				: result.code === 'move-failed' || result.code === 'unreachable'
					? 502
					: 409;
			return json(result, { status });
		} catch (err) {
			return json({ success: false, error: err instanceof Error ? err.message : 'Could not cancel' }, { status: 500 });
		}
	}
	if (action === 'retry') {
		const ok = retryScheduledSend(locals.activeAccountId, params.emailId);
		return json(ok ? { success: true } : { success: false, error: 'Nothing to retry' }, { status: ok ? 200 : 409 });
	}
	return json({ error: 'Unknown action' }, { status: 400 });
};
