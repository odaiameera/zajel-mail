import { JMAPAuthError, type JMAPClient } from '$lib/jmap/client';
import type { Email, Mailbox } from '$lib/jmap/types';
import { getJevSettings, sortingEnabled } from '$lib/server/db/queries/jev-settings';
import { heldCondition, holdEndsAt } from '$lib/inbox-hold';
import { jevMode } from './client';

/**
 * Server side of the Inbox's hold on new mail (see `$lib/inbox-hold`): for
 * which accounts it applies, and how much of the Inbox it is holding now.
 */

/**
 * Whether new mail in this account's Inbox waits for Jev: only while the
 * Inbox has tabs and Jev may read the account's mail. With Jev off, or not
 * configured at all, nothing is held, as nothing would ever sort it.
 */
export function inboxHoldOn(accountRowId: string | null | undefined): boolean {
	if (!accountRowId || jevMode() === 'off') return false;
	return sortingEnabled(getJevSettings(accountRowId));
}

export interface InboxHold {
	/** Unread messages the Inbox is holding. */
	unread: number;
	/** When the first held message is let through if Jev never gets to it (ms), or null. */
	releaseAt: number | null;
}

/** What the Inbox is holding at `now`, in one request. */
export async function heldInInbox(
	client: JMAPClient,
	accountId: string,
	inboxId: string,
	now = Date.now()
): Promise<InboxHold> {
	const held = { operator: 'AND', conditions: [{ inMailbox: inboxId }, heldCondition(now)] };
	const response = await client.request([
		[
			'Email/query',
			{
				accountId,
				filter: { operator: 'AND', conditions: [held, { notKeyword: '$seen' }] },
				calculateTotal: true,
				limit: 0
			},
			'u'
		],
		[
			'Email/query',
			{ accountId, filter: held, sort: [{ property: 'receivedAt', isAscending: true }], limit: 1 },
			'q'
		],
		[
			'Email/get',
			{
				accountId,
				'#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' },
				properties: ['id', 'receivedAt']
			},
			'g'
		]
	]);
	const byTag = new Map(response.methodResponses.map(([, result, tag]) => [tag, result]));
	const unread = (byTag.get('u') as { total?: number } | undefined)?.total ?? 0;
	const oldest = (byTag.get('g') as { list?: Pick<Email, 'receivedAt'>[] } | undefined)?.list?.[0];
	return { unread, releaseAt: oldest ? holdEndsAt(oldest.receivedAt) : null };
}

/**
 * The mailbox list with the Inbox's unread count leaving out held mail, so
 * the sidebar badge and the new-mail alert that watches it don't tick up
 * for a message before it appears in its tab. A failed lookup leaves the
 * list as it was: a count that is a moment early beats a broken page.
 */
export async function withInboxHold(
	client: JMAPClient,
	accountId: string,
	mailboxes: Mailbox[],
	now = Date.now()
): Promise<{ mailboxes: Mailbox[]; releaseAt: number | null }> {
	const inbox = mailboxes.find((m) => m.role === 'inbox');
	if (!inbox) return { mailboxes, releaseAt: null };
	let hold: InboxHold;
	try {
		hold = await heldInInbox(client, accountId, inbox.id, now);
	} catch (err) {
		if (err instanceof JMAPAuthError) throw err;
		console.warn('[jev] could not read the Inbox hold', err instanceof Error ? err.message : err);
		return { mailboxes, releaseAt: null };
	}
	if (hold.unread === 0) return { mailboxes, releaseAt: hold.releaseAt };
	return {
		mailboxes: mailboxes.map((m) =>
			m.id === inbox.id ? { ...m, unreadEmails: Math.max(0, m.unreadEmails - hold.unread) } : m
		),
		releaseAt: hold.releaseAt
	};
}
