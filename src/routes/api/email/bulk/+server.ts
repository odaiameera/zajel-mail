import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createClient } from '$lib/jmap/auth';
import {
	markEmail,
	trashEmail,
	archiveEmail,
	moveEmails,
	markManyAsSpam,
	markManyAsNotSpam,
	destroyEmail,
	emailsInMailbox
} from '$lib/jmap/email';
import { getMailboxes, ensureArchiveMailbox } from '$lib/jmap/mailbox';
import { isInboxCategory } from '$lib/types/categories';
import { labelMailboxIds } from '$lib/types/labels';
import { recordSpamCorrections } from '$lib/server/db/queries/jev-decisions';
import { setTab } from '$lib/server/jev/tab';

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.auth) return json({ error: 'Not authenticated' }, { status: 401 });

	const body = await request.json();
	const ids = body.ids as string[];
	const action = body.action as string;
	const sourceMailboxId = body.sourceMailboxId as string | undefined;

	if (!ids?.length) return json({ error: 'No email IDs provided' }, { status: 400 });

	try {
		const client = createClient(locals.auth);
		const { accountId } = locals.auth;

		// Batched Email/set actions: moveTo, spam, notSpam — one round trip.
		if (action === 'moveTo') {
			const target = body.targetMailboxId as string | undefined;
			if (!target) return json({ error: 'targetMailboxId required' }, { status: 400 });
			const labelIds = labelMailboxIds(await getMailboxes(client, accountId));
			await moveEmails(client, accountId, ids, target, sourceMailboxId, labelIds);
			return json({ success: true });
		}

		// Inbox tab: keywords only, so the messages stay where they are.
		if (action === 'setCategory') {
			if (!isInboxCategory(body.category)) {
				return json({ error: 'invalid category' }, { status: 400 });
			}
			// The move, and what Jev learns from it: shared with the assistant's
			// set_tab tool, so both teach it alike.
			const pinSuggestion = await setTab(client, accountId, locals.activeAccountId, ids, body.category, {
				undoOf: isInboxCategory(body.undoOf) ? body.undoOf : undefined
			});
			return json({ success: true, pinSuggestion });
		}

		if (action === 'spam') {
			const mailboxes = await getMailboxes(client, accountId);
			const junk = mailboxes.find((m) => m.role === 'junk');
			if (!junk) return json({ error: 'Junk folder not found' }, { status: 500 });
			await markManyAsSpam(client, accountId, ids, junk.id, labelMailboxIds(mailboxes));
			if (locals.activeAccountId) recordSpamCorrections(locals.activeAccountId, ids, 'spam');
			return json({ success: true });
		}

		if (action === 'notSpam') {
			const mailboxes = await getMailboxes(client, accountId);
			const junk = mailboxes.find((m) => m.role === 'junk');
			const inbox = mailboxes.find((m) => m.role === 'inbox');
			if (!junk || !inbox) return json({ error: 'Inbox or Junk missing' }, { status: 500 });
			await markManyAsNotSpam(client, accountId, ids, junk.id, inbox.id);
			if (locals.activeAccountId) recordSpamCorrections(locals.activeAccountId, ids, 'ham');
			return json({ success: true });
		}

		if (action === 'trash') {
			const mailboxes = await getMailboxes(client, accountId);
			const trash = mailboxes.find((m) => m.role === 'trash');
			if (!trash) return json({ error: 'Trash folder not found' }, { status: 500 });
			const labelIds = labelMailboxIds(mailboxes);

			// Trash in Trash destroys, but only what is really in Trash. Ids from
			// anywhere else (a selection carried over from another folder) are
			// moved there instead.
			const inTrash =
				sourceMailboxId === trash.id
					? await emailsInMailbox(client, accountId, ids, trash.id)
					: new Set<string>();
			await Promise.all(
				ids.map((id) =>
					inTrash.has(id)
						? destroyEmail(client, accountId, id)
						: trashEmail(client, accountId, id, trash.id, labelIds)
				)
			);
			return json({ success: true });
		}

		let targetMailboxId: string | undefined;
		let labelIds: ReadonlySet<string> = new Set();
		if (action === 'archive') {
			targetMailboxId = await ensureArchiveMailbox(client, accountId);
			labelIds = labelMailboxIds(await getMailboxes(client, accountId));
		}

		await Promise.all(
			ids.map((id) => {
				switch (action) {
					case 'markRead':
						return markEmail(client, accountId, id, true);
					case 'markUnread':
						return markEmail(client, accountId, id, false);
					case 'archive':
						return archiveEmail(client, accountId, id, targetMailboxId!, labelIds);
					default:
						throw new Error(`Unknown action: ${action}`);
				}
			})
		);

		return json({ success: true });
	} catch (err) {
		return json({ error: err instanceof Error ? err.message : 'Bulk action failed' }, { status: 500 });
	}
};
