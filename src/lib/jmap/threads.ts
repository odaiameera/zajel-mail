import type { JMAPClient } from './client';
import type { Email, MethodCall } from './types';
import { getEmailDetail } from './email';
import { jmapSort, type MailSort } from '$lib/mail-prefs';
import {
	countedMembers,
	expandedByDefault,
	summariseThread,
	type ThreadMember,
	type ThreadScope,
	type ThreadSummary
} from '$lib/threads';

/**
 * Conversations over JMAP (RFC 8621).
 *
 * A list page is one Email/query with `collapseThreads`: the server returns
 * one message per thread, the first by the list's order among those that
 * match, and `total` counts threads. The threads of those rows (Thread/get)
 * and a few fields of every message in them then say what each row is: how
 * many messages, who wrote them, what is unread.
 */

/** What a list row shows of its own message. The same as a plain list's. */
const ROW_PROPERTIES = [
	'id', 'blobId', 'threadId', 'mailboxIds',
	'from', 'to', 'cc', 'subject',
	'receivedAt', 'size', 'preview',
	'keywords', 'hasAttachment'
];

/** What a summary needs of every message in a thread. */
const MEMBER_PROPERTIES = ['id', 'threadId', 'mailboxIds', 'keywords', 'from', 'receivedAt', 'hasAttachment'];

/** What a collapsed message in an open conversation shows. */
const CARD_PROPERTIES = [...ROW_PROPERTIES, 'bcc', 'replyTo', 'sentAt', 'messageId', 'inReplyTo', 'references'];

/**
 * How many messages are asked for at once. A server caps a single Email/get
 * (Stalwart's default is 500); a page of fifty long conversations can pass
 * that, so the members are fetched in groups.
 */
const GET_CHUNK = 250;

/** How many messages of an opened conversation come with their bodies; the rest load when opened. */
const DETAILS_AT_ONCE = 8;

function chunk<T>(items: T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
	return out;
}

async function getEmails<T>(client: JMAPClient, accountId: string, ids: string[], properties: string[]): Promise<T[]> {
	const groups = await Promise.all(
		chunk(ids, GET_CHUNK).map(async (group) => {
			const response = await client.request([['Email/get', { accountId, ids: group, properties }, 'g']]);
			return ((response.methodResponses[0]?.[1] as { list?: T[] } | undefined)?.list ?? []) as T[];
		})
	);
	return groups.flat();
}

export interface ThreadQueryResult {
	/** One message per conversation, in the list's order: what each row is built on. */
	emails: Email[];
	/** Conversations matching, not messages. */
	total: number;
	/** threadId → what the row adds for a conversation. Every row has one. */
	threads: Record<string, ThreadSummary>;
}

/**
 * A page of conversations matching `filter`, in `sort` order.
 *
 * Three steps in one request (the query, its rows, their threads), then the
 * members. A thread's members can be anywhere, so they are fetched by id and
 * `scope` decides which count (see countedMembers).
 */
export async function queryThreads(
	client: JMAPClient,
	accountId: string,
	filter: Record<string, unknown>,
	scope: ThreadScope,
	options: { position?: number; limit?: number; sort?: MailSort } = {}
): Promise<ThreadQueryResult> {
	const { position = 0, limit = 50, sort = 'date_desc' } = options;
	const calls: MethodCall[] = [
		['Email/query', { accountId, filter, sort: jmapSort(sort), collapseThreads: true, position, limit, calculateTotal: true }, 'q'],
		['Email/get', { accountId, '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' }, properties: ROW_PROPERTIES }, 'rows'],
		['Thread/get', { accountId, '#ids': { resultOf: 'rows', name: 'Email/get', path: '/list/*/threadId' } }, 't']
	];
	const response = await client.request(calls);
	const query = response.methodResponses[0][1] as { ids?: string[]; total?: number };
	const rows = ((response.methodResponses[1][1] as { list?: Email[] }).list ?? []) as Email[];
	const threadList = ((response.methodResponses[2]?.[1] as { list?: { id: string; emailIds: string[] }[] } | undefined)?.list ?? []);

	// In the query's order, whatever order the server listed them in.
	const byId = new Map(rows.map((e) => [e.id, e]));
	const emails = (query.ids ?? []).map((id) => byId.get(id)).filter((e): e is Email => !!e);

	const memberIds = [...new Set(threadList.flatMap((t) => t.emailIds))];
	const known = new Map<string, ThreadMember>(emails.map((e) => [e.id, e]));
	const missing = memberIds.filter((id) => !known.has(id));
	for (const m of await getEmails<ThreadMember>(client, accountId, missing, MEMBER_PROPERTIES)) known.set(m.id, m);

	const threads: Record<string, ThreadSummary> = {};
	for (const thread of threadList) {
		const members = thread.emailIds.map((id) => known.get(id)).filter((m): m is ThreadMember => !!m);
		threads[thread.id] = summariseThread(thread.id, members, scope);
	}
	// A row whose thread the server didn't return still gets a summary of one.
	for (const email of emails) {
		threads[email.threadId] ??= summariseThread(email.threadId, [email], scope);
	}

	return { emails, total: query.total ?? emails.length, threads };
}

export interface OpenThread {
	threadId: string;
	/** The conversation's messages, oldest first, as their collapsed line needs them. */
	messages: Email[];
	/** id → the whole message, for those that open expanded. The rest load when opened. */
	details: Record<string, Email>;
	/** Messages of the thread left out because they are in Trash or Junk. */
	binned: number;
}

/**
 * The conversation `emailId` belongs to, for reading.
 *
 * Opened from Trash or Junk (the message is in one), it is that mailbox's
 * messages of the thread; from anywhere else, everything not in either.
 */
export async function getThread(
	client: JMAPClient,
	accountId: string,
	emailId: string,
	scope: Omit<ThreadScope, 'hereId'>
): Promise<OpenThread> {
	const response = await client.request([
		['Email/get', { accountId, ids: [emailId], properties: ['threadId', 'mailboxIds'] }, 'e'],
		['Thread/get', { accountId, '#ids': { resultOf: 'e', name: 'Email/get', path: '/list/*/threadId' } }, 't']
	]);
	const asked = (response.methodResponses[0][1] as { list?: Pick<Email, 'id' | 'threadId' | 'mailboxIds'>[] }).list?.[0];
	if (!asked) throw new Error('Email not found');
	const thread = (response.methodResponses[1]?.[1] as { list?: { id: string; emailIds: string[] }[] } | undefined)?.list?.[0];
	const ids = thread?.emailIds?.length ? thread.emailIds : [emailId];

	const all = await getEmails<Email>(client, accountId, ids, CARD_PROPERTIES);
	const here =
		scope.trashId && asked.mailboxIds[scope.trashId]
			? scope.trashId
			: scope.junkId && asked.mailboxIds[scope.junkId]
				? scope.junkId
				: null;
	const messages = countedMembers(all, { ...scope, hereId: here });
	// The one asked for is always shown, whatever happened to it since.
	if (!messages.some((m) => m.id === emailId)) {
		const self = all.find((m) => m.id === emailId);
		if (self) messages.push(self);
	}

	const open = [...expandedByDefault(messages, emailId)];
	// Newest first when there are more than come at once: the last message
	// and the one asked for matter most.
	const wanted = [emailId, ...open.reverse()].filter((id, i, list) => list.indexOf(id) === i).slice(0, DETAILS_AT_ONCE);
	const loaded = await Promise.all(wanted.map((id) => getEmailDetail(client, accountId, id).catch(() => null)));
	const details: Record<string, Email> = {};
	for (const email of loaded) if (email) details[email.id] = email;

	return { threadId: asked.threadId, messages, details, binned: all.length - messages.length };
}
