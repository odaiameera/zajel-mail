import type { Mailbox } from '$lib/jmap/types';
import { byPosition, filterUserFolders } from '$lib/mailboxes';
import { findLabelsParentId, isLabelMailbox } from '$lib/types/labels';

// The tree itself is built in $lib/mailboxes, where what counts as a folder
// is decided; it is re-exported here for the code that rearranges folders.
export {
	buildFolderTree,
	byPosition,
	filterUserFolders,
	flattenFolderTree,
	type FolderOption,
	type FolderTreeNode
} from '$lib/mailboxes';

/**
 * Return the set of folder ids that are descendants of `id` (inclusive).
 * Used to exclude illegal parent choices when editing a folder: you can't
 * re-parent a folder under itself or any of its own children.
 */
export function descendantIds(mailboxes: Mailbox[], id: string): Set<string> {
	const folders = filterUserFolders(mailboxes);
	const childrenOf = new Map<string, Mailbox[]>();
	for (const m of folders) {
		const key = m.parentId ?? '';
		const list = childrenOf.get(key) ?? [];
		list.push(m);
		childrenOf.set(key, list);
	}
	const out = new Set<string>([id]);
	const stack = [id];
	while (stack.length > 0) {
		const cur = stack.pop()!;
		for (const child of childrenOf.get(cur) ?? []) {
			if (!out.has(child.id)) {
				out.add(child.id);
				stack.push(child.id);
			}
		}
	}
	return out;
}

// --- Rearranging: reorder among siblings, nest under another folder ---

/**
 * One rearrangement: put `id` under `parentId` (null for the top level; the
 * Labels container for a label), just before `beforeId`, or last when that
 * is null.
 */
export interface ReorderRequest {
	id: string;
	parentId: string | null;
	beforeId: string | null;
}

/** What a mailbox's `parentId` and `sortOrder` become. */
export interface MailboxPlacement {
	parentId: string | null;
	sortOrder: number;
}

/** The step between neighbours, so a later drop between two has room. */
const STEP = 10;

/**
 * The mailboxes that share a level, in the order they are shown. A label's
 * level is the Labels container; a folder's is its parent or the top level,
 * counting only folders the user may rearrange (so Remind Me Later, Scheduled
 * and the system folders never take part in a top-level renumbering).
 */
export function orderedSiblings(mailboxes: Mailbox[], parentId: string | null, labels: boolean): Mailbox[] {
	const labelsParentId = findLabelsParentId(mailboxes);
	const level = labels
		? mailboxes.filter((m) => isLabelMailbox(m, labelsParentId))
		: filterUserFolders(mailboxes).filter((m) => (m.parentId ?? null) === parentId);
	return level.sort(byPosition);
}

/**
 * Work out every `sortOrder` (and the moved mailbox's `parentId`) a
 * rearrangement needs, as the `Mailbox/set` updates to send. The whole
 * destination level is renumbered so the result does not depend on what
 * the server had before; only mailboxes that actually change are returned.
 *
 * Labels always stay under the Labels container, and a folder can only go
 * among folders: the two lists are shown apart and are kept apart here.
 */
export function planReorder(
	mailboxes: Mailbox[],
	req: ReorderRequest
): Record<string, MailboxPlacement> | { error: string } {
	const labelsParentId = findLabelsParentId(mailboxes);
	const moved = mailboxes.find((m) => m.id === req.id);
	if (!moved) return { error: 'Folder not found' };

	const isLabel = isLabelMailbox(moved, labelsParentId);
	if (isLabel && req.parentId !== labelsParentId) return { error: 'Labels stay under Labels' };
	if (!isLabel && req.parentId !== null && req.parentId === labelsParentId) {
		return { error: 'Folders cannot go among the labels' };
	}

	const siblings = orderedSiblings(mailboxes, req.parentId, isLabel).filter((m) => m.id !== req.id);
	let at = siblings.length;
	if (req.beforeId !== null) {
		at = siblings.findIndex((m) => m.id === req.beforeId);
		if (at < 0) return { error: 'That folder is not at the destination' };
	}
	const level = [...siblings.slice(0, at), moved, ...siblings.slice(at)];

	const updates: Record<string, MailboxPlacement> = {};
	level.forEach((m, i) => {
		const sortOrder = (i + 1) * STEP;
		const parentId = m.id === req.id ? req.parentId : (m.parentId ?? null);
		if (m.sortOrder !== sortOrder || parentId !== (m.parentId ?? null)) {
			updates[m.id] = { parentId, sortOrder };
		}
	});
	return updates;
}

/**
 * The rearrangement that moves `id` one place up or down among its
 * siblings, or null when it is already at that end. For the arrow keys on
 * a row's handle in Settings, which do what a drag does without a pointer.
 */
export function moveStep(mailboxes: Mailbox[], id: string, direction: 'up' | 'down'): ReorderRequest | null {
	const labelsParentId = findLabelsParentId(mailboxes);
	const moved = mailboxes.find((m) => m.id === id);
	if (!moved) return null;
	const isLabel = isLabelMailbox(moved, labelsParentId);
	const parentId = isLabel ? labelsParentId : (moved.parentId ?? null);
	const siblings = orderedSiblings(mailboxes, parentId, isLabel).map((m) => m.id);
	const i = siblings.indexOf(id);
	if (i < 0) return null;
	if (direction === 'up') {
		if (i === 0) return null;
		return { id, parentId, beforeId: siblings[i - 1] };
	}
	if (i === siblings.length - 1) return null;
	// After the next one: before whatever follows it, or last.
	return { id, parentId, beforeId: siblings[i + 2] ?? null };
}

// --- Dragging a row onto another: where it may land, and what that asks for ---

/** Where a dragged row lands relative to the row it is let go on. */
export type DropWhere = 'before' | 'after' | 'into';

/**
 * Can `dragId` land on `targetId` at all? Labels move among labels and
 * folders among folders, nothing lands on itself, and a folder can't go
 * inside itself or one of its own children.
 */
export function canDropMailbox(mailboxes: Mailbox[], dragId: string, targetId: string): boolean {
	if (dragId === targetId) return false;
	const labelsParentId = findLabelsParentId(mailboxes);
	const drag = mailboxes.find((m) => m.id === dragId);
	const target = mailboxes.find((m) => m.id === targetId);
	if (!drag || !target) return false;
	const dragIsLabel = isLabelMailbox(drag, labelsParentId);
	if (dragIsLabel !== isLabelMailbox(target, labelsParentId)) return false;
	if (!dragIsLabel && descendantIds(mailboxes, dragId).has(targetId)) return false;
	return true;
}

/**
 * The rearrangement a drop asks for, or null when it can't land there. Onto
 * a folder's middle it goes inside it, last; before or after a row it joins
 * that row's level. A label has no inside: "into" one counts as after it.
 */
export function dropRequest(
	mailboxes: Mailbox[],
	dragId: string,
	targetId: string,
	where: DropWhere
): ReorderRequest | null {
	if (!canDropMailbox(mailboxes, dragId, targetId)) return null;
	const labelsParentId = findLabelsParentId(mailboxes);
	const target = mailboxes.find((m) => m.id === targetId)!;
	const isLabel = isLabelMailbox(target, labelsParentId);
	if (where === 'into' && !isLabel) return { id: dragId, parentId: targetId, beforeId: null };

	const parentId = isLabel ? labelsParentId : (target.parentId ?? null);
	const siblings = orderedSiblings(mailboxes, parentId, isLabel)
		.map((m) => m.id)
		.filter((id) => id !== dragId);
	const at = siblings.indexOf(targetId);
	if (at < 0) return null;
	return { id: dragId, parentId, beforeId: where === 'before' ? targetId : (siblings[at + 1] ?? null) };
}
