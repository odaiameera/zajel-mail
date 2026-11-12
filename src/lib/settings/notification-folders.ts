/**
 * The folders to tick under Settings → Notifications → "Notify for folders".
 *
 * The stored list is folder ids, for every linked account together. The
 * push worker notifies for the ones that belong to the account it is
 * checking, and for that account's Inbox when none do: nothing was ever
 * chosen, or only another account's folders were. The page used to show the
 * stored list as it was, so in that case no box was ticked although the
 * Inbox did notify. This is the list the page starts from instead: what is
 * stored, plus the Inbox when it is the one being notified. The other
 * accounts' ids stay in it, so saving from one account doesn't drop them.
 */
export function notifiedFolders(
	stored: readonly string[],
	mailboxes: readonly { id: string; role: string | null }[]
): string[] {
	const here = new Set(mailboxes.map((m) => m.id));
	if (stored.some((id) => here.has(id))) return [...stored];
	const inbox = mailboxes.find((m) => m.role === 'inbox')?.id;
	return inbox ? [...stored, inbox] : [...stored];
}
