import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createClient, fetchSession } from '$lib/jmap/auth';
import { markEmail, flagEmail, destroyEmail, emailMailboxMembership, emailsInMailbox, EmailUpdateError } from '$lib/jmap/email';
import { getMailboxes } from '$lib/jmap/mailbox';
import {
	FilingError,
	fileInto,
	markNotSpam,
	markSpam,
	moveToArchive,
	moveToTrash,
	restoreFromTrash
} from '$lib/server/filing';
import { trustSender } from '$lib/server/trust-sender';
import { recordSpamCorrections } from '$lib/server/db/queries/jev-decisions';

export const PATCH: RequestHandler = async ({ request, locals, params }) => {
	if (!locals.auth) return json({ error: 'Not authenticated' }, { status: 401 });

	const body = await request.json();
	const action = body.action as string;
	const emailId = params.id;
	// `sourceMailboxId` (the folder an older client says it was showing) is
	// ignored: moves go by where the message really is, and only an explicit
	// `permanent` deletes for good.
	const permanent = body.permanent === true;

	try {
		const client = createClient(locals.auth);
		const { accountId } = locals.auth;

		switch (action) {
			case 'markRead':
				await markEmail(client, accountId, emailId, true);
				break;
			case 'markUnread':
				await markEmail(client, accountId, emailId, false);
				break;
			case 'flag':
				await flagEmail(client, accountId, emailId, true);
				break;
			case 'unflag':
				await flagEmail(client, accountId, emailId, false);
				break;
			case 'trash': {
				const mailboxes = await getMailboxes(client, accountId);
				const trash = mailboxes.find((m) => m.role === 'trash');
				if (!trash) return json({ error: 'Trash folder not found' }, { status: 500 });
				// Delete for good only when asked to (Trash pressed in the Trash
				// list) and the message really is in Trash. Otherwise it is a move
				// to Trash, which changes nothing for a message already there.
				const inTrash =
					permanent && (await emailsInMailbox(client, accountId, [emailId], trash.id)).has(emailId);
				if (inTrash) {
					await destroyEmail(client, accountId, emailId);
				} else {
					await moveToTrash(client, accountId, [emailId], { mailboxes });
				}
				break;
			}
			case 'restore': {
				// Undo a Trash: back where it was, labels kept.
				const mailboxId = typeof body.mailboxId === 'string' ? body.mailboxId : '';
				await restoreFromTrash(client, accountId, emailId, mailboxId);
				break;
			}
			case 'archive':
				await moveToArchive(client, accountId, [emailId]);
				break;
			case 'spam':
				await markSpam(client, accountId, [emailId]);
				if (locals.activeAccountId) recordSpamCorrections(locals.activeAccountId, [emailId], 'spam');
				break;
			case 'notSpam':
				await markNotSpam(client, accountId, [emailId]);
				if (locals.activeAccountId) recordSpamCorrections(locals.activeAccountId, [emailId], 'ham');
				break;
			/**
			 * Trust the sender: add them to the address book and, if the message
			 * is sitting in Junk, bring it back and train the classifier on it.
			 *
			 * The address book is the lever here. Stalwart's spam filter treats
			 * mail from a known contact as legitimate whatever it would
			 * otherwise have scored, so this exempts one sender without
			 * loosening the threshold for anyone else.
			 */
			case 'trustSender': {
				const address = typeof body.address === 'string' ? body.address : '';
				if (!address) return json({ error: 'address required' }, { status: 400 });
				const displayName = typeof body.name === 'string' ? body.name : null;

				const session = await fetchSession(locals.auth);
				const trust = await trustSender(client, session, address, displayName);

				// Independently of the contact, get the message out of Junk if
				// that is where it landed — the reason the user pressed this.
				// Whether it is in Junk is read from the server, not from the view.
				let movedOut = false;
				const mailboxes = await getMailboxes(client, accountId);
				const junk = mailboxes.find((m) => m.role === 'junk');
				const inbox = mailboxes.find((m) => m.role === 'inbox');
				const current = (await emailMailboxMembership(client, accountId, [emailId])).get(emailId);
				if (junk && inbox && current?.[junk.id]) {
					await markNotSpam(client, accountId, [emailId], { mailboxes });
					movedOut = true;
				}

				return json({ success: true, trust, movedOut });
			}
			case 'moveTo': {
				const targetMailboxId = body.targetMailboxId as string | undefined;
				if (!targetMailboxId) return json({ error: 'targetMailboxId required' }, { status: 400 });
				// A label adds the label; a folder is a move; anything else is refused.
				await fileInto(client, accountId, [emailId], targetMailboxId);
				break;
			}
			default:
				return json({ error: `Unknown action: ${action}` }, { status: 400 });
		}

		return json({ success: true });
	} catch (err) {
		if (err instanceof FilingError) return json({ error: err.message }, { status: err.status });
		if (err instanceof EmailUpdateError && err.failures.every((f) => f.type === 'notFound')) {
			return json({ error: 'Email not found' }, { status: 404 });
		}
		return json({ error: err instanceof Error ? err.message : 'Action failed' }, { status: 500 });
	}
};
