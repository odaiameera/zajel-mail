import { createClient } from '$lib/jmap/auth';
import { getMailboxes } from '$lib/jmap/mailbox';
import { inboxHoldSince, withInboxHold } from '$lib/server/mail-pipeline/hold';
import { authStateForAccount, type MailAccountRow } from './accounts';

/**
 * Inbox unread counts for the account switcher's non-active accounts.
 * One Mailbox/get per account, cached briefly so layout loads (which run
 * on every navigation) don't fan out to the mail server each time.
 * Failures are non-fatal — a missing badge beats a broken page.
 */

const TTL_MS = 30 * 1000;
const cache = new Map<string, { at: number; unread: number }>();

export async function unreadBadges(
	accounts: MailAccountRow[],
	excludeId: string | undefined
): Promise<Record<string, number>> {
	const out: Record<string, number> = {};
	await Promise.all(
		accounts
			.filter((a) => a.id !== excludeId && a.needs_reauth !== 1)
			.map(async (account) => {
				const hit = cache.get(account.id);
				if (hit && Date.now() - hit.at < TTL_MS) {
					out[account.id] = hit.unread;
					return;
				}
				try {
					const auth = authStateForAccount(account);
					const client = createClient(auth);
					let mailboxes = await getMailboxes(client, auth.accountId);
					// Mail the Inbox is still holding for Jev isn't counted yet.
					const holdSince = inboxHoldSince(account.id);
					if (holdSince !== null) ({ mailboxes } = await withInboxHold(client, auth.accountId, account.id, mailboxes, holdSince));
					const unread = mailboxes.find((m) => m.role === 'inbox')?.unreadEmails ?? 0;
					cache.set(account.id, { at: Date.now(), unread });
					out[account.id] = unread;
				} catch {
					// Skip the badge for this account this time around.
				}
			})
	);
	return out;
}
