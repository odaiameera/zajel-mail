import type { JMAPClient } from './client';
import type { Mailbox } from './types';
import { emailMailboxMembership, updateEmailMailboxes, type EmailMailboxChange } from './email';
import { LABELS_PARENT_NAME, findLabelsParentId } from '$lib/types/labels';

export type CreateLabelResult = { id: string } | { error: string };
export type MutateLabelResult = { success: true; id?: string } | { success: false; error: string };

/** Fetch every mailbox (id/name/parentId) — the shared building block. */
async function getAllMailboxes(client: JMAPClient, accountId: string): Promise<Mailbox[]> {
	const response = await client.request([
		[
			'Mailbox/get',
			{
				accountId,
				ids: null,
				properties: ['id', 'name', 'role', 'sortOrder', 'totalEmails', 'unreadEmails', 'parentId']
			},
			'0'
		]
	]);
	return (response.methodResponses[0][1] as { list: Mailbox[] }).list ?? [];
}

/**
 * Find or create the "Labels" container mailbox and return its id. Labels are
 * children of this mailbox, so it must exist before any label is created.
 */
export async function ensureLabelsParent(client: JMAPClient, accountId: string): Promise<string> {
	const mailboxes = await getAllMailboxes(client, accountId);
	const existing = findLabelsParentId(mailboxes);
	if (existing) return existing;

	const response = await client.request([
		[
			'Mailbox/set',
			{
				accountId,
				create: { labels: { name: LABELS_PARENT_NAME, role: null, parentId: null } }
			},
			'0'
		]
	]);

	const result = response.methodResponses[0][1] as {
		created?: Record<string, { id: string }>;
	};
	const id = result.created?.labels?.id;
	if (!id) throw new Error('Could not create the Labels container mailbox');
	return id;
}

/**
 * Return every label mailbox — i.e. every direct child of the "Labels"
 * container. Returns [] if the container doesn't exist yet.
 */
export async function listLabelMailboxes(
	client: JMAPClient,
	accountId: string
): Promise<Mailbox[]> {
	const mailboxes = await getAllMailboxes(client, accountId);
	const parentId = findLabelsParentId(mailboxes);
	if (!parentId) return [];
	return mailboxes.filter((m) => m.parentId === parentId);
}

/**
 * Create a label as a child mailbox of "Labels", named with the real display
 * name (e.g. "Work Stuff"). The container is created on demand. Over IMAP this
 * surfaces as `Labels/Work Stuff` — clean and grouped, no slug.
 */
export async function createLabelMailbox(
	client: JMAPClient,
	accountId: string,
	displayName: string
): Promise<CreateLabelResult> {
	const name = displayName.trim();
	if (!name) return { error: 'Label name is required' };

	let parentId: string;
	try {
		parentId = await ensureLabelsParent(client, accountId);
	} catch (err) {
		return { error: err instanceof Error ? err.message : 'Could not prepare Labels container' };
	}

	const response = await client.request([
		[
			'Mailbox/set',
			{
				accountId,
				create: { lbl1: { name, role: null, parentId } }
			},
			'0'
		]
	]);

	const result = response.methodResponses[0][1] as {
		created?: Record<string, { id: string }>;
		notCreated?: Record<string, { type: string; description?: string }>;
	};

	if (result.notCreated?.lbl1) {
		const err = result.notCreated.lbl1;
		return { error: err.description ?? err.type ?? 'Failed to create label' };
	}

	const id = result.created?.lbl1?.id;
	if (!id) return { error: 'Label created but no id returned' };
	return { id };
}

/** Rename a label by setting its mailbox name to the new display name. */
export async function renameLabelMailbox(
	client: JMAPClient,
	accountId: string,
	id: string,
	newDisplayName: string
): Promise<MutateLabelResult> {
	const name = newDisplayName.trim();
	if (!name) return { success: false, error: 'Label name is required' };

	const response = await client.request([
		[
			'Mailbox/set',
			{
				accountId,
				update: { [id]: { name } }
			},
			'0'
		]
	]);

	const result = response.methodResponses[0][1] as {
		notUpdated?: Record<string, { type: string; description?: string }>;
	};

	if (result.notUpdated?.[id]) {
		const err = result.notUpdated[id];
		return { success: false, error: err.description ?? err.type ?? 'Rename failed' };
	}
	return { success: true, id };
}

/** Messages detached per round while a label is being deleted. */
const DETACH_PAGE = 200;
/** Rounds before giving up, so a server that keeps a message put can't loop us forever. */
const DETACH_MAX_ROUNDS = 500;

/**
 * Take every message out of a label. A message that is in nothing but the
 * label (it was "moved to" the label) goes into `fallback()`, Archive in
 * practice, since JMAP never lets a message have no mailbox at all. The
 * fallback is only looked up when such a message turns up.
 */
async function detachAll(
	client: JMAPClient,
	accountId: string,
	labelMailboxId: string,
	fallback: () => Promise<string>
): Promise<void> {
	let fallbackId: string | null = null;
	let lastFirst: string | null = null;
	for (let round = 0; round < DETACH_MAX_ROUNDS; round++) {
		const query = await client.request([
			['Email/query', { accountId, filter: { inMailbox: labelMailboxId }, limit: DETACH_PAGE }, '0']
		]);
		const ids = (query.methodResponses[0][1] as { ids?: string[] }).ids ?? [];
		if (ids.length === 0) return;
		// The same page twice means the server kept them in: stop rather than spin.
		if (ids[0] === lastFirst) throw new Error('Could not take the messages out of the label');
		lastFirst = ids[0];

		const membership = await emailMailboxMembership(client, accountId, ids);
		const changes: Record<string, EmailMailboxChange> = {};
		for (const emailId of ids) {
			const cur = membership.get(emailId);
			if (!cur) continue;
			const alone = Object.keys(cur).every((mb) => mb === labelMailboxId);
			if (alone) fallbackId ??= await fallback();
			changes[emailId] = { remove: [labelMailboxId], add: alone && fallbackId ? [fallbackId] : [] };
		}
		await updateEmailMailboxes(client, accountId, changes);
		if (ids.length < DETACH_PAGE) return;
	}
	throw new Error('Could not take the messages out of the label');
}

/**
 * Destroy a label mailbox, keeping its messages. RFC 8621's
 * `onDestroyRemoveEmails: false` does not detach them: it makes the server
 * refuse to destroy a mailbox that still has any (`mailboxHasEmail`), which
 * is how deleting a label that had ever been used always failed. So the
 * messages are taken out first ({@link detachAll}), then the empty mailbox
 * goes, still with `false` so nothing can ever be deleted by this call.
 */
export async function deleteLabelMailbox(
	client: JMAPClient,
	accountId: string,
	id: string,
	fallback: () => Promise<string>
): Promise<MutateLabelResult> {
	try {
		await detachAll(client, accountId, id, fallback);
	} catch (err) {
		return { success: false, error: err instanceof Error ? err.message : 'Could not empty the label' };
	}

	const response = await client.request([
		[
			'Mailbox/set',
			{
				accountId,
				destroy: [id],
				onDestroyRemoveEmails: false
			},
			'0'
		]
	]);

	const result = response.methodResponses[0][1] as {
		destroyed?: string[];
		notDestroyed?: Record<string, { type: string; description?: string }>;
	};

	if (result.notDestroyed?.[id]) {
		const err = result.notDestroyed[id];
		return { success: false, error: err.description ?? err.type ?? 'Delete failed' };
	}
	return { success: true, id };
}

/**
 * Add `labelMailboxId` to the email's mailboxIds (multi-mailbox membership).
 * Goes through the full-object write path — label mailboxes are created
 * late, so they're prime candidates for the all-digit ids that Stalwart's
 * pointer parser (jmap-tools ≤ 0.1.4) rejects.
 */
export async function applyLabel(
	client: JMAPClient,
	accountId: string,
	emailId: string,
	labelMailboxId: string
): Promise<void> {
	await updateEmailMailboxes(client, accountId, {
		[emailId]: { add: [labelMailboxId] }
	});
}

/**
 * Remove `labelMailboxId` from the email's mailboxIds. A message that is in
 * nothing but this label would be left with no mailbox, which JMAP refuses
 * and the writer used to answer by quietly changing nothing; it goes into
 * `fallback()` (Archive) instead, so removing the label always removes it.
 */
export async function removeLabel(
	client: JMAPClient,
	accountId: string,
	emailId: string,
	labelMailboxId: string,
	fallback?: () => Promise<string>
): Promise<void> {
	const cur = (await emailMailboxMembership(client, accountId, [emailId])).get(emailId);
	const alone = !!cur && cur[labelMailboxId] === true && Object.keys(cur).every((mb) => mb === labelMailboxId);
	await updateEmailMailboxes(client, accountId, {
		[emailId]: { remove: [labelMailboxId], add: alone && fallback ? [await fallback()] : [] }
	});
}
