import { json } from '@sveltejs/kit';
import { deleteRulesForMailbox } from '$lib/server/rules/store';
import type { RequestHandler } from './$types';
import { createClient } from '$lib/jmap/auth';
import { getMailboxes } from '$lib/jmap/mailbox';
import {
	createFolder,
	deleteFolder,
	moveFolder,
	renameFolder,
	reorderMailboxes,
	validateFolderName
} from '$lib/jmap/folders';
import { findLabelsParentId, isLabelMailbox, isLabelsParent } from '$lib/types/labels';
import { planReorder } from '$lib/utils/folder-tree';
import type { Mailbox } from '$lib/jmap/types';

type CreateBody = { action: 'create'; name: string; parentId?: string | null };
type RenameBody = { action: 'rename'; id: string; name: string };
type DeleteBody = { action: 'delete'; id: string };
type MoveBody = { action: 'move'; id: string; newParentId: string | null };
/**
 * Rearrange: put a folder or label under `parentId` (null for the top level;
 * for a label, the Labels container), just before `beforeId` or last.
 */
type ReorderBody = { action: 'reorder'; id: string; parentId: string | null; beforeId?: string | null };
type Body = CreateBody | RenameBody | DeleteBody | MoveBody | ReorderBody;

/** True if putting `id` under `newParentId` would make it its own ancestor. */
function wouldCycle(byId: Map<string, Mailbox>, id: string, newParentId: string): boolean {
	let cur: Mailbox | undefined = byId.get(newParentId);
	const seen = new Set<string>();
	while (cur?.parentId && !seen.has(cur.parentId)) {
		if (cur.parentId === id) return true;
		seen.add(cur.parentId);
		cur = byId.get(cur.parentId);
	}
	return false;
}

/**
 * True if any `labels/*` mailbox has `id` somewhere in its parent chain.
 * Labels are root-level today, but a user could theoretically nest them
 * under a custom folder — destroying that folder would also destroy the
 * labels and silently break cross-client membership.
 */
function isAncestorOfLabel(id: string, mailboxes: Mailbox[], labelsParentId: string | null): boolean {
	const byId = new Map(mailboxes.map((m) => [m.id, m]));
	for (const m of mailboxes) {
		if (!isLabelMailbox(m, labelsParentId)) continue;
		let cur: Mailbox | undefined = m;
		const seen = new Set<string>();
		while (cur?.parentId && !seen.has(cur.parentId)) {
			if (cur.parentId === id) return true;
			seen.add(cur.parentId);
			cur = byId.get(cur.parentId);
		}
	}
	return false;
}

function isSystem(m: Mailbox): boolean {
	return m.role !== null;
}
/** Label children AND the "Labels" container are off-limits to the folder API. */
function isLabel(m: Mailbox, labelsParentId: string | null): boolean {
	return isLabelMailbox(m, labelsParentId) || isLabelsParent(m, labelsParentId);
}

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.auth) return json({ error: 'Not authenticated' }, { status: 401 });

	const body = (await request.json()) as Body;
	const client = createClient(locals.auth);
	const accountId = locals.auth.accountId;

	// A single mailbox fetch serves both validation and the refreshed list we
	// return to the client — except after a mutation, where we re-fetch.
	const mailboxes = await getMailboxes(client, accountId);
	const byId = new Map(mailboxes.map((m) => [m.id, m]));
	const labelsParentId = findLabelsParentId(mailboxes);

	switch (body.action) {
		case 'create': {
			const err = validateFolderName(body.name);
			if (err) return json({ success: false, error: err }, { status: 400 });

			if (body.parentId) {
				const parent = byId.get(body.parentId);
				if (!parent) return json({ success: false, error: 'Parent folder not found' }, { status: 404 });
				if (isLabel(parent, labelsParentId)) return json({ success: false, error: 'Cannot nest folders under labels' }, { status: 400 });
			}

			const result = await createFolder(client, accountId, {
				name: body.name.trim(),
				parentId: body.parentId ?? null
			});
			if ('error' in result) return json({ success: false, error: result.error }, { status: 400 });

			const refreshed = await getMailboxes(client, accountId);
			return json({ success: true, id: result.id, mailboxes: refreshed });
		}

		case 'rename': {
			const target = byId.get(body.id);
			if (!target) return json({ success: false, error: 'Folder not found' }, { status: 404 });
			if (isSystem(target)) return json({ success: false, error: 'System folders cannot be renamed' }, { status: 403 });
			if (isLabel(target, labelsParentId)) return json({ success: false, error: 'Rename labels from the Labels settings' }, { status: 400 });

			const err = validateFolderName(body.name);
			if (err) return json({ success: false, error: err }, { status: 400 });

			const result = await renameFolder(client, accountId, body.id, body.name);
			if (!result.success) return json({ success: false, error: result.error }, { status: 400 });

			const refreshed = await getMailboxes(client, accountId);
			return json({ success: true, mailboxes: refreshed });
		}

		case 'delete': {
			const target = byId.get(body.id);
			if (!target) return json({ success: false, error: 'Folder not found' }, { status: 404 });
			if (isSystem(target)) return json({ success: false, error: 'System folders cannot be deleted' }, { status: 403 });
			if (isLabel(target, labelsParentId)) return json({ success: false, error: 'Delete labels from the Labels settings' }, { status: 400 });
			if (isAncestorOfLabel(body.id, mailboxes, labelsParentId)) {
				return json({ success: false, error: 'Remove labels inside this folder first' }, { status: 400 });
			}

			const result = await deleteFolder(client, accountId, body.id);
			if (!result.success) return json({ success: false, error: result.error }, { status: 400 });
			// The rules that filed into it go with it: they have nowhere left to file.
			const rulesDeleted = locals.activeAccountId ? deleteRulesForMailbox(locals.activeAccountId, body.id) : 0;

			const refreshed = await getMailboxes(client, accountId);
			return json({ success: true, mailboxes: refreshed, rulesDeleted });
		}

		case 'move': {
			const target = byId.get(body.id);
			if (!target) return json({ success: false, error: 'Folder not found' }, { status: 404 });
			if (isSystem(target)) return json({ success: false, error: 'System folders cannot be moved' }, { status: 403 });
			if (isLabel(target, labelsParentId)) return json({ success: false, error: 'Labels live at the root' }, { status: 400 });

			if (body.newParentId) {
				if (body.newParentId === body.id) {
					return json({ success: false, error: 'A folder cannot be its own parent' }, { status: 400 });
				}
				const parent = byId.get(body.newParentId);
				if (!parent) return json({ success: false, error: 'Parent folder not found' }, { status: 404 });
				if (isLabel(parent, labelsParentId)) return json({ success: false, error: 'Cannot nest folders under labels' }, { status: 400 });

				if (wouldCycle(byId, body.id, body.newParentId)) {
					return json({ success: false, error: 'Cannot move a folder into one of its descendants' }, { status: 400 });
				}
			}

			const result = await moveFolder(client, accountId, body.id, body.newParentId);
			if (!result.success) return json({ success: false, error: result.error }, { status: 400 });

			const refreshed = await getMailboxes(client, accountId);
			return json({ success: true, mailboxes: refreshed });
		}

		case 'reorder': {
			const target = byId.get(body.id);
			if (!target) return json({ success: false, error: 'Folder not found' }, { status: 404 });
			if (isSystem(target)) return json({ success: false, error: 'System folders keep their place' }, { status: 403 });
			if (isLabelsParent(target, labelsParentId)) return json({ success: false, error: 'Folder not found' }, { status: 404 });

			const parentId = body.parentId ?? null;
			const beforeId = body.beforeId ?? null;
			if (isLabelMailbox(target, labelsParentId)) {
				// A label's place is among the labels, nowhere else.
				if (parentId !== labelsParentId) return json({ success: false, error: 'Labels stay under Labels' }, { status: 400 });
			} else if (parentId) {
				if (parentId === body.id) return json({ success: false, error: 'A folder cannot be its own parent' }, { status: 400 });
				const parent = byId.get(parentId);
				if (!parent) return json({ success: false, error: 'Parent folder not found' }, { status: 404 });
				if (isLabel(parent, labelsParentId)) return json({ success: false, error: 'Cannot nest folders under labels' }, { status: 400 });
				if (wouldCycle(byId, body.id, parentId)) {
					return json({ success: false, error: 'Cannot move a folder into one of its descendants' }, { status: 400 });
				}
			}
			if (beforeId) {
				const before = byId.get(beforeId);
				if (!before || (before.parentId ?? null) !== parentId) {
					return json({ success: false, error: 'That folder is not at the destination' }, { status: 400 });
				}
			}

			const plan = planReorder(mailboxes, { id: body.id, parentId, beforeId });
			if ('error' in plan) return json({ success: false, error: plan.error }, { status: 400 });

			const result = await reorderMailboxes(client, accountId, plan);
			if (!result.success) return json({ success: false, error: result.error }, { status: 400 });

			const refreshed = await getMailboxes(client, accountId);
			return json({ success: true, mailboxes: refreshed });
		}

		default:
			return json({ error: 'Unknown action' }, { status: 400 });
	}
};
