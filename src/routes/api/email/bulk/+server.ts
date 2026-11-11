import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createClient } from '$lib/jmap/auth';
import { markEmail, destroyEmail, emailsInMailbox, EmailUpdateError } from '$lib/jmap/email';
import { getMailboxes } from '$lib/jmap/mailbox';
import { isInboxCategory } from '$lib/types/categories';
import { FilingError, fileInto, markNotSpam, markSpam, moveToArchive, moveToTrash } from '$lib/server/filing';
import { recordSpamCorrections } from '$lib/server/db/queries/jev-decisions';
import { setTab } from '$lib/server/jev/tab';

/**
 * Run one write over the selection and say which messages it couldn't
 * change. A refusal for some messages doesn't stop the rest, so the answer
 * is the ids that failed; anything other than a refusal is thrown.
 */
async function refusedIds(write: () => Promise<void>): Promise<string[]> {
	try {
		await write();
		return [];
	} catch (err) {
		if (err instanceof EmailUpdateError) return [...new Set(err.failures.map((f) => f.id))];
		throw err;
	}
}

/**
 * 200 when at least one message was written, naming the ones that weren't
 * in `failed`; 500 when none was.
 */
function report(ids: string[], failed: string[]) {
	const done = new Set(ids);
	for (const id of failed) done.delete(id);
	if (failed.length > 0 && done.size === 0) {
		return json({ error: 'No message could be changed', failed }, { status: 500 });
	}
	return json({ success: true, failed });
}

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.auth) return json({ error: 'Not authenticated' }, { status: 401 });

	const body = await request.json();
	const ids = body.ids as string[];
	const action = body.action as string;
	// `sourceMailboxId` (the folder an older client says it was showing) is
	// ignored: moves go by where each message really is, and only an
	// explicit `permanent` deletes for good.
	const permanent = body.permanent === true;

	if (!ids?.length) return json({ error: 'No email IDs provided' }, { status: 400 });

	try {
		const client = createClient(locals.auth);
		const { accountId } = locals.auth;

		// Moves, Spam, Not spam, Archive and Trash write in batches (see
		// sendEmailUpdates); a refusal for some messages is reported, not fatal.
		if (action === 'moveTo') {
			const target = body.targetMailboxId as string | undefined;
			if (!target) return json({ error: 'targetMailboxId required' }, { status: 400 });
			// A label adds the label; a folder is a move; anything else is refused.
			return report(ids, await refusedIds(() => fileInto(client, accountId, ids, target).then(() => {})));
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

		if (action === 'spam' || action === 'notSpam') {
			const failed = await refusedIds(() => (action === 'spam' ? markSpam : markNotSpam)(client, accountId, ids));
			// What Jev learns from: only the messages that were really moved.
			const written = ids.filter((id) => !failed.includes(id));
			if (locals.activeAccountId && written.length > 0) {
				recordSpamCorrections(locals.activeAccountId, written, action === 'spam' ? 'spam' : 'ham');
			}
			return report(ids, failed);
		}

		if (action === 'archive') {
			return report(ids, await refusedIds(() => moveToArchive(client, accountId, ids)));
		}

		if (action === 'trash') {
			const mailboxes = await getMailboxes(client, accountId);
			const trash = mailboxes.find((m) => m.role === 'trash');
			if (!trash) return json({ error: 'Trash folder not found' }, { status: 500 });

			// Delete for good only when asked to (Trash pressed in the Trash
			// list), and only what is really in Trash. The rest (a selection
			// carried over from another folder) is moved there instead.
			const inTrash = permanent ? await emailsInMailbox(client, accountId, ids, trash.id) : new Set<string>();
			const failed = (
				await Promise.all(
					ids.filter((id) => inTrash.has(id)).map((id) => refusedIds(() => destroyEmail(client, accountId, id)))
				)
			).flat();
			const rest = ids.filter((id) => !inTrash.has(id));
			failed.push(...(await refusedIds(() => moveToTrash(client, accountId, rest, { mailboxes }))));
			return report(ids, failed);
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
