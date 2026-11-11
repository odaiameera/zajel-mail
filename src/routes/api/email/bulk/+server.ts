import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createClient } from '$lib/jmap/auth';
import { markEmail, destroyEmail, emailsInMailbox } from '$lib/jmap/email';
import { getMailboxes } from '$lib/jmap/mailbox';
import { isInboxCategory } from '$lib/types/categories';
import { FilingError, fileInto, markNotSpam, markSpam, moveToArchive, moveToTrash } from '$lib/server/filing';
import { recordSpamCorrections } from '$lib/server/db/queries/jev-decisions';
import { setTab } from '$lib/server/jev/tab';

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.auth) return json({ error: 'Not authenticated' }, { status: 401 });

	const body = await request.json();
	const ids = body.ids as string[];
	const action = body.action as string;
	// The folder the list was showing. Moves no longer read it (they go by
	// where each message really is); Trash reads it only to know that it was
	// pressed in Trash, where it deletes for good.
	const viewMailboxId = body.sourceMailboxId as string | undefined;

	if (!ids?.length) return json({ error: 'No email IDs provided' }, { status: 400 });

	try {
		const client = createClient(locals.auth);
		const { accountId } = locals.auth;

		// Batched Email/set actions: moveTo, spam, notSpam, archive: one write each.
		if (action === 'moveTo') {
			const target = body.targetMailboxId as string | undefined;
			if (!target) return json({ error: 'targetMailboxId required' }, { status: 400 });
			// A label adds the label; a folder is a move; anything else is refused.
			await fileInto(client, accountId, ids, target);
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
			await markSpam(client, accountId, ids);
			if (locals.activeAccountId) recordSpamCorrections(locals.activeAccountId, ids, 'spam');
			return json({ success: true });
		}

		if (action === 'notSpam') {
			await markNotSpam(client, accountId, ids);
			if (locals.activeAccountId) recordSpamCorrections(locals.activeAccountId, ids, 'ham');
			return json({ success: true });
		}

		if (action === 'archive') {
			await moveToArchive(client, accountId, ids);
			return json({ success: true });
		}

		if (action === 'trash') {
			const mailboxes = await getMailboxes(client, accountId);
			const trash = mailboxes.find((m) => m.role === 'trash');
			if (!trash) return json({ error: 'Trash folder not found' }, { status: 500 });

			// Trash in Trash destroys, but only what is really in Trash. Ids from
			// anywhere else (a selection carried over from another folder) are
			// moved there instead.
			const inTrash =
				viewMailboxId === trash.id
					? await emailsInMailbox(client, accountId, ids, trash.id)
					: new Set<string>();
			await Promise.all(ids.filter((id) => inTrash.has(id)).map((id) => destroyEmail(client, accountId, id)));
			await moveToTrash(client, accountId, ids.filter((id) => !inTrash.has(id)), { mailboxes });
			return json({ success: true });
		}

		await Promise.all(
			ids.map((id) => {
				switch (action) {
					case 'markRead':
						return markEmail(client, accountId, id, true);
					case 'markUnread':
						return markEmail(client, accountId, id, false);
					default:
						throw new Error(`Unknown action: ${action}`);
				}
			})
		);

		return json({ success: true });
	} catch (err) {
		if (err instanceof FilingError) return json({ error: err.message }, { status: err.status });
		return json({ error: err instanceof Error ? err.message : 'Bulk action failed' }, { status: 500 });
	}
};
