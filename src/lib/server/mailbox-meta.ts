import { listMailboxMeta, type MailboxMetaRow } from '$lib/server/db/queries/mailbox-meta';
import { lucideNode } from '$lib/server/lucide-icons';
import type { MailboxMetaMap, MailboxMetaView } from '$lib/types/mailbox-meta';

export function mailboxMetaView(row: MailboxMetaRow): MailboxMetaView {
	return { color: row.color, icon: row.icon, iconNode: lucideNode(row.icon), displayName: row.displayName };
}

/** Every folder's and label's metadata for one mail account, by mailbox id. */
export function mailboxMetaFor(accountId: string | null | undefined): MailboxMetaMap {
	if (!accountId) return {};
	return Object.fromEntries(listMailboxMeta(accountId).map((row) => [row.mailboxId, mailboxMetaView(row)]));
}
