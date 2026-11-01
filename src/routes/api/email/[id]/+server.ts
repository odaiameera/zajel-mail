import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createClient, fetchSession } from '$lib/jmap/auth';
import { markEmail, flagEmail, trashEmail, archiveEmail, moveEmail, markAsSpam, markAsNotSpam, destroyEmail, emailsInMailbox } from '$lib/jmap/email';
import { getMailboxes, ensureArchiveMailbox } from '$lib/jmap/mailbox';
import { labelMailboxIds } from '$lib/types/labels';
import { trustSender } from '$lib/server/trust-sender';
import { recordSpamCorrections } from '$lib/server/db/queries/jev-decisions';

export const PATCH: RequestHandler = async ({ request, locals, params }) => {
	if (!locals.auth) return json({ error: 'Not authenticated' }, { status: 401 });

	const body = await request.json();
	const action = body.action as string;
	const emailId = params.id;
	const sourceMailboxId = body.sourceMailboxId as string | undefined;

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
				// Destroy only a message that is really in Trash.
				const inTrash =
					sourceMailboxId === trash.id &&
					(await emailsInMailbox(client, accountId, [emailId], trash.id)).has(emailId);
				if (inTrash) {
					await destroyEmail(client, accountId, emailId);
				} else {
					await trashEmail(client, accountId, emailId, trash.id, labelMailboxIds(mailboxes));
				}
				break;
			}
			case 'archive': {
				const archiveId = await ensureArchiveMailbox(client, accountId);
				if (!archiveId) return json({ error: 'Could not create Archive' }, { status: 500 });
				const labelIds = labelMailboxIds(await getMailboxes(client, accountId));
				await archiveEmail(client, accountId, emailId, archiveId, labelIds);
				break;
			}
			case 'spam': {
				const mailboxes = await getMailboxes(client, accountId);
				const junk = mailboxes.find((m) => m.role === 'junk');
				if (!junk) return json({ error: 'Junk folder not found' }, { status: 500 });
				await markAsSpam(client, accountId, emailId, junk.id, labelMailboxIds(mailboxes));
				if (locals.activeAccountId) recordSpamCorrections(locals.activeAccountId, [emailId], 'spam');
				break;
			}
			case 'notSpam': {
				const mailboxes = await getMailboxes(client, accountId);
				const junk = mailboxes.find((m) => m.role === 'junk');
				const inbox = mailboxes.find((m) => m.role === 'inbox');
				if (!junk || !inbox) return json({ error: 'Inbox or Junk folder missing' }, { status: 500 });
				await markAsNotSpam(client, accountId, emailId, junk.id, inbox.id);
				if (locals.activeAccountId) recordSpamCorrections(locals.activeAccountId, [emailId], 'ham');
				break;
			}
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
				let movedOut = false;
				const mailboxes = await getMailboxes(client, accountId);
				const junk = mailboxes.find((m) => m.role === 'junk');
				const inbox = mailboxes.find((m) => m.role === 'inbox');
				if (junk && inbox && sourceMailboxId === junk.id) {
					await markAsNotSpam(client, accountId, emailId, junk.id, inbox.id);
					movedOut = true;
				}

				return json({ success: true, trust, movedOut });
			}
			case 'moveTo': {
				const targetMailboxId = body.targetMailboxId as string | undefined;
				if (!targetMailboxId) return json({ error: 'targetMailboxId required' }, { status: 400 });
				const labelIds = labelMailboxIds(await getMailboxes(client, accountId));
				await moveEmail(client, accountId, emailId, targetMailboxId, sourceMailboxId, labelIds);
				break;
			}
			default:
				return json({ error: `Unknown action: ${action}` }, { status: 400 });
		}

		return json({ success: true });
	} catch (err) {
		return json({ error: err instanceof Error ? err.message : 'Action failed' }, { status: 500 });
	}
};
