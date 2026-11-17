import type { JMAPClient } from '$lib/jmap/client';
import type { Email, Mailbox } from '$lib/jmap/types';
import { queryAndFetchEmails, queryAndFetchEmailsWithFilter } from '$lib/jmap/email';
import { queryThreads } from '$lib/jmap/threads';
import { isScheduledMailbox } from '$lib/jmap/mailbox';
import type { MailSort } from '$lib/mail-prefs';
import type { ThreadScope, ThreadSummary } from '$lib/threads';
import { conversationsOn } from './db/queries/app-prefs';

/**
 * A page of a mail list: conversations when Conversation view is on
 * (Settings → Messages), messages when it is off. One place, so the Inbox,
 * a folder and Starred can't come to list differently.
 */

/** The mailboxes that decide which messages of a thread a list counts. */
export function threadScope(mailboxes: Mailbox[], hereId: string | null): ThreadScope {
	const byRole = (role: string) => mailboxes.find((m) => m.role === role)?.id ?? null;
	return { hereId, trashId: byRole('trash'), junkId: byRole('junk'), draftsId: byRole('drafts') };
}

/**
 * Whether a mailbox lists conversations. Drafts and Scheduled don't: each
 * row there is a message of yours waiting to go, with its own Edit or its
 * own send time, and two drafts in one thread are two things to finish.
 */
export function listsConversations(mailbox: Mailbox | null): boolean {
	if (!mailbox) return true;
	return mailbox.role !== 'drafts' && !isScheduledMailbox(mailbox);
}

export interface ListPage {
	emails: Email[];
	total: number;
	/** threadId → the row's conversation; null when the list is of messages. */
	threads: Record<string, ThreadSummary> | null;
}

export async function loadListPage(
	client: JMAPClient,
	accountId: string,
	userId: string,
	mailboxes: Mailbox[],
	list: {
		/** The mailbox listed, or null for a list across mailboxes (Starred). */
		mailbox: Mailbox | null;
		/** ANDed with the mailbox, or the whole filter when there is none. */
		filter: Record<string, unknown> | null;
		position: number;
		limit: number;
		sort: MailSort;
	}
): Promise<ListPage> {
	const { mailbox, filter, position, limit, sort } = list;
	if (!conversationsOn(userId) || !listsConversations(mailbox)) {
		const result = mailbox
			? await queryAndFetchEmails(client, accountId, mailbox.id, { position, limit, sort, extraFilter: filter })
			: await queryAndFetchEmailsWithFilter(client, accountId, filter ?? {}, { position, limit, sort });
		return { emails: result.emails, total: result.total, threads: null };
	}
	const whole = mailbox
		? filter
			? { operator: 'AND', conditions: [{ inMailbox: mailbox.id }, filter] }
			: { inMailbox: mailbox.id }
		: (filter ?? {});
	return queryThreads(client, accountId, whole, threadScope(mailboxes, mailbox?.id ?? null), { position, limit, sort });
}
