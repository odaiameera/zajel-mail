import cron from 'node-cron';
import { listSchedulableAuths, markNeedsReauth } from './auth/accounts';
import { JMAPAuthError } from '$lib/jmap/client';
import { createClient } from '$lib/jmap/auth';
import { emailMailboxMembership, EmailUpdateError, updateEmailMailboxes } from '$lib/jmap/email';
import { getMailboxes } from '$lib/jmap/mailbox';
import { isRemindMeLaterMailbox } from '$lib/mailboxes';
import {
	listDueReminders,
	deleteReminder,
	markReturned,
	cleanupOldMarkers,
	type ReminderRow
} from './db/queries/reminders';
import type { AuthState } from '$lib/jmap/types';
import { errorFields, logEvent } from './log';

/**
 * Fires every minute. Iterates every linked mail account (credentials
 * live encrypted in mail_accounts) and processes any due reminders for
 * each — no live login required, and container restarts don't pause the
 * queue. Accounts whose stored credentials the server rejects get
 * flagged needs_reauth and skipped until re-linked.
 *
 * Running this every minute is enough for the product: the user either
 * has the tab open (SSE push picks up the moved email instantly) or is
 * away (in which case "within a minute of returning" is fine).
 */

let started = false;
// The error last logged per reminder: one that keeps failing (a folder that
// is gone) is logged when it starts, not every minute.
const lastError = new Map<ReminderRow['id'], string>();

export function startReminderScheduler(): void {
	if (started) return;
	started = true;

	cron.schedule('* * * * *', async () => {
		try {
			for (const { account, auth, email } of listSchedulableAuths()) {
				const due = listDueReminders(email);
				if (due.length === 0) continue;
				for (const r of due) {
					try {
						await returnReminder(auth, email, r);
						lastError.delete(r.id);
					} catch (err) {
						if (err instanceof JMAPAuthError) {
							markNeedsReauth(account.id);
							break;
						}
						// Leave the row; next tick will retry. One noisy log is
						// better than a silent stall since this is a background
						// job users can't see.
						console.error('[reminder] return failed', r.id, err);
						const fields = errorFields(err);
						if (lastError.get(r.id) !== fields.error) {
							lastError.set(r.id, String(fields.error));
							logEvent('warn', 'reminders', 'return_failed', { reminder: r.id, ...fields });
						}
					}
				}
			}
		} catch (err) {
			// node-cron swallows a throw with no one listening.
			console.error('[reminder] tick failed', err);
			logEvent('error', 'reminders', 'tick_failed', errorFields(err));
		}
	});

	// Daily marker sweep at 03:15 local. Cheap query, idempotent.
	cron.schedule('15 3 * * *', () => {
		try {
			cleanupOldMarkers();
		} catch (err) {
			console.error('[reminder] marker cleanup failed', err);
		}
	});
}

/**
 * Process a single due reminder: move the email from the RML mailbox back
 * to its original mailbox (the Inbox if that folder has gone since), clear
 * the read flag so it looks new again, record the "returned from reminder"
 * marker, then drop the reminders row.
 *
 * The row is dropped only once the move has worked, or when the email no
 * longer exists. A move the server refuses throws, so the row stays and the
 * next tick tries again.
 */
async function returnReminder(
	auth: AuthState,
	userEmail: string,
	r: ReminderRow
): Promise<void> {
	const client = createClient(auth);
	const mailboxes = await getMailboxes(client, r.account_id);
	const rml = mailboxes.find(isRemindMeLaterMailbox);
	const target =
		mailboxes.find((m) => m.id === r.original_mailbox_id) ?? mailboxes.find((m) => m.role === 'inbox');
	if (!target) throw new Error('No mailbox to return the reminder to');

	// Only a message still waiting in Remind Me Later comes back. One the
	// user trashed, archived or filed by hand meanwhile has moved on, and
	// returning it would undo that (and mark it unread); its reminder is
	// simply over.
	const current = (await emailMailboxMembership(client, r.account_id, [r.jmap_email_id])).get(r.jmap_email_id);
	if (!current || (rml && !current[rml.id])) {
		deleteReminder(userEmail, r.jmap_email_id);
		return;
	}

	try {
		await updateEmailMailboxes(client, r.account_id, {
			[r.jmap_email_id]: {
				add: [target.id],
				remove: rml && rml.id !== target.id ? [rml.id] : [],
				keywords: { $seen: false }
			}
		});
	} catch (err) {
		if (err instanceof EmailUpdateError && err.failures.every((f) => f.type === 'notFound')) {
			deleteReminder(userEmail, r.jmap_email_id);
			return;
		}
		throw err;
	}

	markReturned(userEmail, r.jmap_email_id);
	deleteReminder(userEmail, r.jmap_email_id);
}

/**
 * On-demand path used by hooks.server.ts. When a request lands for an
 * authenticated user we process any reminders that are already due so the
 * user isn't waiting up to 60s on the cron tick. Errors swallowed — we'd
 * rather the request continue than 500 over a reminder glitch.
 */
export async function processDueRemindersForUser(
	auth: AuthState,
	userEmail: string
): Promise<void> {
	try {
		const due = listDueReminders(userEmail);
		for (const r of due) {
			// One refused return shouldn't hold up the others.
			try {
				await returnReminder(auth, userEmail, r);
			} catch (err) {
				if (err instanceof JMAPAuthError) throw err;
				console.error('[reminder] on-demand return failed', r.id, err);
			}
		}
	} catch (err) {
		console.error('[reminder] on-demand return failed', err);
	}
}
