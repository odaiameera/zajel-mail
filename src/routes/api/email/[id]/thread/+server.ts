import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createClient } from '$lib/jmap/auth';
import { getMailboxes } from '$lib/jmap/mailbox';
import { getThread } from '$lib/jmap/threads';
import { threadScope } from '$lib/server/conversations';
import { userEmailFromAuth } from '$lib/server/user';
import { clearMarker } from '$lib/server/db/queries/reminders';

/**
 * The conversation a message belongs to, for the reading pane: its messages
 * oldest first, and the whole of those that open expanded. A message with no
 * other in its thread comes back as a conversation of one.
 */
export const GET: RequestHandler = async ({ locals, params }) => {
	if (!locals.auth) return json({ error: 'Not authenticated' }, { status: 401 });

	try {
		const client = createClient(locals.auth);
		const { accountId } = locals.auth;
		const mailboxes = await getMailboxes(client, accountId);
		const thread = await getThread(client, accountId, params.id, threadScope(mailboxes, null));
		// Opening a message that came back from Remind Me Later clears its mark.
		clearMarker(userEmailFromAuth(locals.auth), params.id);
		return json(thread);
	} catch (err) {
		return json({ error: err instanceof Error ? err.message : 'Failed to load the conversation' }, { status: 500 });
	}
};
