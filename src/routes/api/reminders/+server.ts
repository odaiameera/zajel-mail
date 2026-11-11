import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createClient } from '$lib/jmap/auth';
import { userEmailFromAuth } from '$lib/server/user';
import { listReminders } from '$lib/server/db/queries/reminders';
import { FilingError, snoozeEmail } from '$lib/server/filing';

/**
 * Snooze: the message leaves every folder it is in for Remind Me Later,
 * keeps its labels, and comes back to the folder it was in when the
 * reminder is due. The assistant and Telegram snooze the same way
 * (`snoozeEmail` in $lib/server/filing).
 *
 * The client may name the folder it was looking at (`sourceMailboxId`), but
 * that is a hint: from Starred or Search the list has no folder and used to
 * send whatever mailbox came first, a label as often as not, so the message
 * stayed in the Inbox and was later "returned" to a label it never left.
 * Where the message really is comes from the server.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.auth) return json({ error: 'Not authenticated' }, { status: 401 });

	const body = (await request.json().catch(() => null)) as {
		emailId?: string;
		remindAt?: string;
		sourceMailboxId?: string;
	} | null;
	const emailId = body?.emailId;
	const remindAt = body?.remindAt;
	const hint = body?.sourceMailboxId || undefined;

	if (!emailId || !remindAt) {
		return json({ error: 'emailId and remindAt are required' }, { status: 400 });
	}
	const d = new Date(remindAt);
	if (isNaN(d.getTime())) {
		return json({ error: 'remindAt must be a valid ISO date' }, { status: 400 });
	}

	try {
		const userEmail = userEmailFromAuth(locals.auth);
		const client = createClient(locals.auth);
		const { returnsTo } = await snoozeEmail(client, locals.auth.accountId, userEmail, emailId, d, hint);
		return json({ success: true, remindAt: d.toISOString(), returnsTo });
	} catch (err) {
		if (err instanceof FilingError) return json({ error: err.message }, { status: err.status });
		return json(
			{ error: err instanceof Error ? err.message : 'Failed to schedule reminder' },
			{ status: 500 }
		);
	}
};

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.auth) return json({ error: 'Not authenticated' }, { status: 401 });
	const userEmail = userEmailFromAuth(locals.auth);
	const rows = listReminders(userEmail).map((r) => ({
		emailId: r.jmap_email_id,
		originalMailboxId: r.original_mailbox_id,
		remindAt: r.remind_at
	}));
	return json({ reminders: rows });
};
