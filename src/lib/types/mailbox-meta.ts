import type { IconNode } from './icon-node';

/**
 * A folder's or label's colour, icon and display name, as the browser gets
 * them with the page: null where nothing was chosen. The icon's drawing is
 * sent with its name, so the browser never needs the whole icon set.
 */
export interface MailboxMetaView {
	color: string | null;
	icon: string | null;
	iconNode: IconNode | null;
	displayName: string | null;
}

/** The active account's metadata, by mailbox id. */
export type MailboxMetaMap = Record<string, MailboxMetaView>;
