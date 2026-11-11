import type { IconNode } from './icon-node';

export interface Label {
	/** JMAP Mailbox id (authoritative — this is the mailbox id in JMAP/IMAP) */
	id: string;
	/** Display name (the mailbox's own name, e.g. "Work Stuff") */
	name: string;
	/** Hex colour: the one chosen (mailbox_meta), or one handed out automatically. */
	color: string;
	/** A Lucide icon name, or null for the colour dot. */
	icon?: string | null;
	/** Its drawing, sent by the server with the name. */
	iconNode?: IconNode | null;
}

/**
 * Display name of the parent mailbox that contains every label. Labels are
 * real child mailboxes of this container (`parentId`-based), which is what
 * lets them sync to Apple Mail / Thunderbird as a clean `Labels/<name>` tree
 * — no slugs, no `/` jammed into a single mailbox name.
 */
export const LABELS_PARENT_NAME = 'Labels';

/**
 * The account's labels, shared with every component through Svelte context.
 * It is an accessor rather than the array itself so that a label created in
 * Settings, or a switch to another account, reaches the open list and
 * reading pane: the layout that sets the context never remounts, and a
 * plain array would hold the first page load's labels for good.
 */
export const LABELS_CONTEXT = 'labels';
export interface LabelsContext {
	readonly current: Label[];
}

/** Default color for labels that have no meta entry. */
export const DEFAULT_LABEL_COLOR = '#0969da';

/** Cookie marker for the one-shot keyword→mailbox migration (value `v1`). */
export const LABEL_MIGRATION_COOKIE = 'mail_labels_migrated';

/** Legacy cookie holding the pre-migration keyword-based labels. */
export const LEGACY_LABELS_COOKIE = 'mail_labels';

type MailboxLike = { id: string; name: string; parentId: string | null };

/**
 * The id of the "Labels" container mailbox, or null if it doesn't exist yet
 * (it's created lazily the first time a label is made).
 */
export function findLabelsParentId(mailboxes: MailboxLike[]): string | null {
	return mailboxes.find((m) => m.parentId === null && m.name === LABELS_PARENT_NAME)?.id ?? null;
}

/** True if `m` is a label — i.e. a direct child of the Labels container. */
export function isLabelMailbox(
	m: { parentId: string | null },
	labelsParentId: string | null
): boolean {
	return labelsParentId !== null && m.parentId === labelsParentId;
}

/** The ids of every label mailbox. */
export function labelMailboxIds(mailboxes: MailboxLike[]): Set<string> {
	const parentId = findLabelsParentId(mailboxes);
	return new Set(mailboxes.filter((m) => isLabelMailbox(m, parentId)).map((m) => m.id));
}

/** True if `m` is the Labels container itself (not a real folder, not a label). */
export function isLabelsParent(m: { id: string }, labelsParentId: string | null): boolean {
	return labelsParentId !== null && m.id === labelsParentId;
}
