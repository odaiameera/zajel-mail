import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createClient } from '$lib/jmap/auth';
import { emailMailboxMembership, moveEmail } from '$lib/jmap/email';
import { ensureRemindMeLaterMailbox, getMailboxes, REMIND_ME_LATER_NAME } from '$lib/jmap/mailbox';
import { labelMailboxIds } from '$lib/types/labels';
import { userEmailFromAuth } from '$lib/server/user';
import { scheduleReminder, listReminders } from '$lib/server/db/queries/reminders';

/**
 * Snooze: the message leaves every folder it is in for Remind Me Later,
 * keeps its labels, and comes back to the folder it was in when the
 * reminder is due.
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
		const { accountId } = locals.auth;

		const mailboxes = await getMailboxes(client, accountId);
		const rmlId =
			mailboxes.find((m) => m.name === REMIND_ME_LATER_NAME && m.parentId === null)?.id ??
			(await ensureRemindMeLaterMailbox(client, accountId));
		if (!rmlId) {
			return json({ error: 'Could not create Remind Me Later mailbox' }, { status: 500 });
		}
		const labelIds = labelMailboxIds(mailboxes);

		const current = (await emailMailboxMembership(client, accountId, [emailId])).get(emailId);
		if (!current) return json({ error: 'Email not found' }, { status: 404 });
		if (current[rmlId]) {
			return json({ error: 'Email is already in Remind Me Later' }, { status: 400 });
		}

		// The folder to come back to: the one the client named, if the message
		// is really in it and it is a folder; else the first folder it is in;
		// else the Inbox.
		const folders = Object.keys(current).filter((id) => !labelIds.has(id));
		const origin =
			(hint && current[hint] && !labelIds.has(hint) ? hint : undefined) ??
			folders[0] ??
			mailboxes.find((m) => m.role === 'inbox')?.id;
		if (!origin) return json({ error: 'No folder to return the email to' }, { status: 500 });

		// Leave every folder, keep every label.
		await moveEmail(client, accountId, emailId, rmlId, undefined, labelIds);
		scheduleReminder(userEmail, accountId, emailId, origin, d.toISOString());

		return json({ success: true, remindAt: d.toISOString(), returnsTo: origin });
	} catch (err) {
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
