import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createClient } from '$lib/jmap/auth';
import { emailMailboxMembership, EmailUpdateError, updateEmailMailboxes } from '$lib/jmap/email';
import { getMailboxes, REMIND_ME_LATER_NAME } from '$lib/jmap/mailbox';
import { userEmailFromAuth } from '$lib/server/user';
import { deleteReminder, getReminder } from '$lib/server/db/queries/reminders';

/**
 * Cancel a pending reminder: bring the message back from Remind Me Later to
 * the folder it came from (the Inbox if that folder is gone), then forget the
 * reminder. The row goes only once the move has worked, so a refused move
 * leaves a reminder that can be cancelled again rather than a message
 * stranded in Remind Me Later with nothing pointing at it. A message the
 * user has already moved on by hand is left where it is. 404 when there is
 * no active reminder for that id.
 */
export const DELETE: RequestHandler = async ({ locals, params }) => {
	if (!locals.auth) return json({ error: 'Not authenticated' }, { status: 401 });

	try {
		const userEmail = userEmailFromAuth(locals.auth);
		const row = getReminder(userEmail, params.emailId);
		if (!row) {
			return json({ error: 'No active reminder for that email' }, { status: 404 });
		}

		const client = createClient(locals.auth);
		const { accountId } = locals.auth;
		const mailboxes = await getMailboxes(client, accountId);
		const rml = mailboxes.find((m) => m.name === REMIND_ME_LATER_NAME && m.parentId === null);
		const target =
			mailboxes.find((m) => m.id === row.original_mailbox_id) ?? mailboxes.find((m) => m.role === 'inbox');

		const current = (await emailMailboxMembership(client, accountId, [params.emailId])).get(params.emailId);
		// Gone, or taken out of Remind Me Later by hand: nothing to bring back.
		if (!current || !rml || !current[rml.id]) {
			deleteReminder(userEmail, params.emailId);
			return json({ success: true, returnedTo: null });
		}
		if (!target) return json({ error: 'No folder to return the email to' }, { status: 500 });

		try {
			await updateEmailMailboxes(client, accountId, {
				[params.emailId]: { add: [target.id], remove: rml.id !== target.id ? [rml.id] : [] }
			});
		} catch (err) {
			if (!(err instanceof EmailUpdateError && err.failures.every((f) => f.type === 'notFound'))) throw err;
		}
		deleteReminder(userEmail, params.emailId);
		return json({ success: true, returnedTo: target.id });
	} catch (err) {
		return json(
			{ error: err instanceof Error ? err.message : 'Failed to cancel reminder' },
			{ status: 500 }
		);
	}
};
