import type { Mailbox } from '$lib/jmap/types';
import { REMIND_ME_LATER_NAME, isScheduledMailbox } from '$lib/jmap/mailbox';
import { findLabelsParentId, isLabelMailbox, isLabelsParent } from '$lib/types/labels';

export type FolderTreeNode = Mailbox & { children: FolderTreeNode[] };

export type FolderOption = {
	id: string;
	name: string;
	depth: number;
};

/**
 * The order folders and labels are shown in: the position the user gave
 * them (JMAP `sortOrder`), then the name. A server hands every mailbox the
 * same sortOrder until someone drags one, so an untouched account reads
 * alphabetically, and a reordered level keeps its order in every client that
 * honours sortOrder.
 */
export function byPosition(a: Pick<Mailbox, 'sortOrder' | 'name'>, b: Pick<Mailbox, 'sortOrder' | 'name'>): number {
	return a.sortOrder - b.sortOrder || a.name.localeCompare(b.name);
}

/**
 * Keep only the folders the user made and may rearrange. Out go system
 * folders (non-null role), the "Labels" container and its children, and the
 * two folders the app itself keeps at the top level: Remind Me Later and
 * Scheduled, which reminders and Send later depend on.
 */
export function filterUserFolders(mailboxes: Mailbox[]): Mailbox[] {
	const labelsParentId = findLabelsParentId(mailboxes);
	return mailboxes.filter(
		(m) =>
			m.role === null &&
			!isLabelMailbox(m, labelsParentId) &&
			!isLabelsParent(m, labelsParentId) &&
			!(m.name === REMIND_ME_LATER_NAME && m.parentId === null) &&
			!isScheduledMailbox(m)
	);
}

/**
 * Build a nested tree of user folders, each level in its own order
 * (see {@link byPosition}).
 */
export function buildFolderTree(mailboxes: Mailbox[]): FolderTreeNode[] {
	const folders = filterUserFolders(mailboxes);
	const byId = new Map<string, FolderTreeNode>(
		folders.map((m) => [m.id, { ...m, children: [] }])
	);
	const roots: FolderTreeNode[] = [];
	for (const node of byId.values()) {
		const parent = node.parentId ? byId.get(node.parentId) : undefined;
		if (parent) parent.children.push(node);
		else roots.push(node);
	}
	const sortLevel = (nodes: FolderTreeNode[]) => {
		nodes.sort(byPosition);
		for (const n of nodes) sortLevel(n.children);
	};
	sortLevel(roots);
	return roots;
}

/**
 * Flatten a folder tree into an ordered list with a `depth` hint for
 * indented dropdown rendering.
 */
export function flattenFolderTree(tree: FolderTreeNode[]): FolderOption[] {
	const out: FolderOption[] = [];
	const walk = (nodes: FolderTreeNode[], depth: number) => {
		for (const n of nodes) {
			out.push({ id: n.id, name: n.name, depth });
			walk(n.children, depth + 1);
		}
	};
	walk(tree, 0);
	return out;
}

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
 * siblings, or null when it is already at that end. For the Move up / Move
 * down buttons, which do what a drag does without a pointer.
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
