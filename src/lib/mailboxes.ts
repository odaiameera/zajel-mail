import type { Mailbox } from '$lib/jmap/types';
import { findLabelsParentId, isLabelMailbox, labelMailboxIds } from '$lib/types/labels';

/**
 * What kind of place each mailbox is, and what filing a message does.
 *
 * A message is in exactly one folder and any number of labels. Everything
 * that moves mail, on the server or in the browser, asks this module what a
 * mailbox is and what a message's mailboxes become, so a hand move, a rule,
 * the assistant and a job all file mail the same way.
 */

type MailboxLike = Pick<Mailbox, 'id' | 'name' | 'role' | 'parentId'>;

/**
 * - `system`: has a role (Inbox, Archive, Sent, Drafts, Junk, Trash and so on).
 * - `special`: the app's own Remind Me Later and Scheduled.
 * - `labels-root`: the top-level `Labels` mailbox that holds the labels.
 * - `label`: a direct child of the labels root.
 * - `folder`: everything else.
 */
export type MailboxKind = 'system' | 'special' | 'labels-root' | 'label' | 'folder';

export const REMIND_ME_LATER_NAME = 'Remind Me Later';

/**
 * Messages waiting for Send later or Undo send. A server may mark such a
 * folder with the 'scheduled' role; otherwise it's ours, found by name at
 * the top level like Remind Me Later.
 */
export const SCHEDULED_NAME = 'Scheduled';

export function isScheduledMailbox(m: Pick<Mailbox, 'name' | 'role' | 'parentId'>): boolean {
	return m.role === 'scheduled' || (m.role === null && m.parentId === null && m.name === SCHEDULED_NAME);
}

/** Remind Me Later: the app's own, found by name at the top level. */
export function isRemindMeLaterMailbox(m: Pick<Mailbox, 'name' | 'role' | 'parentId'>): boolean {
	return !m.role && m.parentId === null && m.name === REMIND_ME_LATER_NAME;
}

export function mailboxKind(mailbox: MailboxLike, mailboxes: MailboxLike[]): MailboxKind {
	if (isScheduledMailbox(mailbox) || isRemindMeLaterMailbox(mailbox)) return 'special';
	if (mailbox.role) return 'system';
	const labelsRoot = findLabelsParentId(mailboxes);
	if (labelsRoot !== null && mailbox.id === labelsRoot) return 'labels-root';
	if (isLabelMailbox(mailbox, labelsRoot)) return 'label';
	return 'folder';
}

/** The system folders mail may be moved into. Drafts and Sent are not among them. */
export const MOVABLE_ROLES = ['inbox', 'archive', 'junk', 'trash'] as const;

/**
 * A folder some mail servers and clients keep sent mail in without marking
 * it as Sent. The app has never offered it as a place to move mail.
 */
export const SENT_MESSAGES_NAME = 'Sent Messages';

/**
 * Whether a message may be moved into this mailbox: a folder, or the Inbox,
 * Archive, Junk or Trash. Never a label, the labels root, Remind Me Later,
 * Scheduled, Drafts, Sent, or a folder named "Sent Messages".
 */
export function canMoveInto(mailbox: MailboxLike, mailboxes: MailboxLike[]): boolean {
	const kind = mailboxKind(mailbox, mailboxes);
	if (kind === 'folder') return mailbox.name !== SENT_MESSAGES_NAME;
	return kind === 'system' && (MOVABLE_ROLES as readonly string[]).includes(mailbox.role ?? '');
}

/**
 * Whether mail dragged onto this mailbox is taken: a move into anywhere
 * {@link canMoveInto} allows, or a label (which is added, moving nothing).
 * The sidebar asks this and nothing else.
 */
export function canDropOn(mailbox: MailboxLike, mailboxes: MailboxLike[]): boolean {
	return canMoveInto(mailbox, mailboxes) || mailboxKind(mailbox, mailboxes) === 'label';
}

export type FilingOp =
	| { move: string }
	| { addLabel: string }
	/** `archiveId` is where a message goes that would be left in nothing; null when there is none yet. */
	| { removeLabel: string; archiveId: string | null };

/**
 * The `mailboxIds` a message has after one filing step.
 *
 * - Move: the message is in the destination and keeps its labels; it leaves
 *   every other mailbox, wherever the caller thought it was.
 * - Add a label: the label is added; nothing else changes.
 * - Remove a label: the label goes. A message that would be left in nothing
 *   goes to Archive; null when that is needed and `archiveId` is null, so the
 *   caller can find or make Archive and ask again.
 */
export function nextMailboxIds(
	current: Record<string, boolean>,
	op: FilingOp,
	mailboxes: MailboxLike[]
): Record<string, boolean> | null {
	const now = Object.keys(current).filter((id) => current[id]);
	if ('move' in op) {
		// Leave every mailbox the list knows and calls something other than a
		// label. An id the list doesn't know (a label made after the list was
		// loaded) is kept: never take mail out of a mailbox we can't identify.
		const labels = labelMailboxIds(mailboxes);
		const known = new Set(mailboxes.map((m) => m.id));
		const next: Record<string, boolean> = { [op.move]: true };
		for (const id of now) if (labels.has(id) || !known.has(id)) next[id] = true;
		return next;
	}
	if ('addLabel' in op) {
		const next: Record<string, boolean> = Object.fromEntries(now.map((id) => [id, true]));
		next[op.addLabel] = true;
		return next;
	}
	const rest = now.filter((id) => id !== op.removeLabel);
	if (rest.length > 0) return Object.fromEntries(rest.map((id) => [id, true]));
	return op.archiveId ? { [op.archiveId]: true } : null;
}

/**
 * True when any of these messages is in a mailbox the list doesn't know:
 * the list is older than the mailbox (a label made since it was loaded).
 */
export function hasUnknownMailbox(
	placements: Iterable<Record<string, boolean>>,
	mailboxes: Pick<Mailbox, 'id'>[]
): boolean {
	const known = new Set(mailboxes.map((m) => m.id));
	for (const ids of placements) {
		for (const id of Object.keys(ids)) if (ids[id] && !known.has(id)) return true;
	}
	return false;
}

/** True when two `mailboxIds` objects name the same mailboxes. */
export function sameMailboxIds(a: Record<string, boolean>, b: Record<string, boolean>): boolean {
	const ka = Object.keys(a).filter((k) => a[k]);
	const kb = Object.keys(b).filter((k) => b[k]);
	return ka.length === kb.length && ka.every((k) => b[k]);
}

// --- The folder tree ---------------------------------------------------------

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
 * The folders the user made and may rearrange: every mailbox of kind
 * `folder`. System folders, the labels root and its labels, Remind Me Later
 * and Scheduled are left out.
 */
export function filterUserFolders(mailboxes: Mailbox[]): Mailbox[] {
	return mailboxes.filter((m) => mailboxKind(m, mailboxes) === 'folder');
}

/**
 * Build a nested tree of user folders, each level in its own order
 * (see {@link byPosition}).
 */
export function buildFolderTree(mailboxes: Mailbox[]): FolderTreeNode[] {
	const folders = filterUserFolders(mailboxes);
	const byId = new Map<string, FolderTreeNode>(folders.map((m) => [m.id, { ...m, children: [] }]));
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

/** The folder tree as a flat, indented list, for pickers. */
export function folderOptions(mailboxes: Mailbox[]): FolderOption[] {
	return flattenFolderTree(buildFolderTree(mailboxes));
}

/** The system folders mail can be moved into, in the order pickers list them. */
export function movableSystemFolders<T extends MailboxLike>(mailboxes: T[]): T[] {
	const out: T[] = [];
	for (const role of MOVABLE_ROLES) {
		const m = mailboxes.find((b) => b.role === role);
		if (m) out.push(m);
	}
	return out;
}

/** The labels, in the order they are shown. */
export function labelsInOrder(mailboxes: Mailbox[]): Mailbox[] {
	return mailboxes.filter((m) => mailboxKind(m, mailboxes) === 'label').sort(byPosition);
}
