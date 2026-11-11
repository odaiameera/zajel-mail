import { JMAPAuthError, type JMAPClient } from '$lib/jmap/client';
import type { Email, Mailbox } from '$lib/jmap/types';
import { getJevSettings, sortingEnabled } from '$lib/server/db/queries/jev-settings';
import { listPins } from '$lib/server/db/queries/jev-learning';
import { heldCondition, holdEndsAt } from '$lib/inbox-hold';
import { jevMode } from './client';

/**
 * Server side of the Inbox's hold on new mail (see `$lib/inbox-hold`): for
 * which accounts it applies, and how much of the Inbox it is holding now.
 */

/**
 * Whether new mail in this account's Inbox waits to be sorted: only while
 * the Inbox has tabs and something will put new mail in them. That is Jev,
 * when it may read the account's mail, or your sender pins, which act with
 * Jev off or not configured at all: without the hold, a pinned sender's
 * mail would show in Important for a moment and then jump to its tab.
 *
 * With tabs but neither, nothing is held, as nothing would ever sort it.
 * This is the same test the sorting pass makes before it runs (see
 * sortNewMail), so mail is only ever held for a pass that will mark it.
 */
export function inboxHoldOn(accountRowId: string | null | undefined): boolean {
	if (!accountRowId) return false;
	const settings = getJevSettings(accountRowId);
	if (!settings.inboxTabs) return false;
	if (jevMode() !== 'off' && sortingEnabled(settings)) return true;
	return listPins(accountRowId).length > 0;
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
 * What the Inbox is holding, or null when the mail server couldn't say
 * (a lost sign-in still throws, for the caller's re-login handling).
 */
export async function readInboxHold(
	client: JMAPClient,
	accountId: string,
	inboxId: string,
	now = Date.now()
): Promise<InboxHold | null> {
	try {
		return await heldInInbox(client, accountId, inboxId, now);
	} catch (err) {
		if (err instanceof JMAPAuthError) throw err;
		console.warn('[jev] could not read the Inbox hold', err instanceof Error ? err.message : err);
		return null;
	}
}

// Per linked account: its Inbox's id, so the next page load can ask about
// the hold alongside the mailboxes instead of after them, and the unread
// count last shown, for a load where the hold can't be read.
const known = new Map<string, { inboxId: string; shownUnread: number }>();

/** The Inbox id seen on this account's last load, if any. */
export function knownInboxId(accountRowId: string): string | undefined {
	return known.get(accountRowId)?.inboxId;
}

/**
 * The mailbox list with the Inbox's unread count leaving out held mail, so
 * the sidebar badge and the new-mail alert that watches it don't tick up
 * for a message before it appears in its tab.
 *
 * When the hold couldn't be read, the count is the mail server's own, but
 * never above what was last shown: rising for a held message, dropping on
 * the next load and rising again when it appears would alert twice.
 */
export function applyInboxHold(
	accountRowId: string,
	mailboxes: Mailbox[],
	hold: InboxHold | null
): { mailboxes: Mailbox[]; releaseAt: number | null } {
	const inbox = mailboxes.find((m) => m.role === 'inbox');
	if (!inbox) return { mailboxes, releaseAt: null };
	const last = known.get(accountRowId);
	const unread = hold
		? Math.max(0, inbox.unreadEmails - hold.unread)
		: last?.inboxId === inbox.id
			? Math.min(inbox.unreadEmails, last.shownUnread)
			: inbox.unreadEmails;
	known.set(accountRowId, { inboxId: inbox.id, shownUnread: unread });
	return {
		mailboxes:
			unread === inbox.unreadEmails
				? mailboxes
				: mailboxes.map((m) => (m.id === inbox.id ? { ...m, unreadEmails: unread } : m)),
		releaseAt: hold?.releaseAt ?? null
	};
}

/** applyInboxHold, reading the hold after the mailboxes: for callers that have them already. */
export async function withInboxHold(
	client: JMAPClient,
	accountId: string,
	accountRowId: string,
	mailboxes: Mailbox[],
	now = Date.now()
): Promise<{ mailboxes: Mailbox[]; releaseAt: number | null }> {
	const inbox = mailboxes.find((m) => m.role === 'inbox');
	if (!inbox) return { mailboxes, releaseAt: null };
	return applyInboxHold(accountRowId, mailboxes, await readInboxHold(client, accountId, inbox.id, now));
}

/** Forget what was last shown: for tests. */
export function forgetInboxHolds(): void {
	known.clear();
}
