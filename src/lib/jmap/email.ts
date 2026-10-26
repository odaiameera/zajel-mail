import type { JMAPClient } from './client';
import type {
	ComposeAttachment,
	ComposeEmail,
	Email,
	EmailAddress,
	EmailQueryResult,
	JMAPResponse,
	MethodCall
} from './types';
import {
	INBOX_CATEGORIES,
	categoryCondition,
	categoryKeywordPatch,
	isInboxCategory,
	type InboxCategory
} from '$lib/types/categories';
import { htmlToText } from '$lib/utils/html-to-text';

const LIST_PROPERTIES = [
	'id', 'blobId', 'threadId', 'mailboxIds',
	'from', 'to', 'cc', 'subject',
	'receivedAt', 'size', 'preview',
	'keywords', 'hasAttachment'
];

export async function queryAndFetchEmails(
	client: JMAPClient,
	accountId: string,
	mailboxId: string,
	options: { position?: number; limit?: number; extraFilter?: Record<string, unknown> | null } = {}
): Promise<EmailQueryResult> {
	const { position = 0, limit = 50, extraFilter = null } = options;

	// AND the quick-filter condition (if any) with the mailbox constraint.
	const filter = extraFilter
		? { operator: 'AND', conditions: [{ inMailbox: mailboxId }, extraFilter] }
		: { inMailbox: mailboxId };

	const response = await client.request([
		[
			'Email/query',
			{
				accountId,
				filter,
				sort: [{ property: 'receivedAt', isAscending: false }],
				position,
				limit,
				calculateTotal: true
			},
			'q'
		],
		[
			'Email/get',
			{
				accountId,
				'#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' },
				properties: LIST_PROPERTIES
			},
			'g'
		]
	]);

	const queryResult = response.methodResponses[0][1] as { total: number };
	const getResult = response.methodResponses[1][1] as { list: Email[] };

	return {
		emails: getResult.list,
		total: queryResult.total
	};
}

/**
 * Unread count for each Inbox tab, in one request: four `limit: 0` queries
 * the server answers with a total and no ids.
 */
export async function countUnreadByCategory(
	client: JMAPClient,
	accountId: string,
	inboxId: string
): Promise<Record<InboxCategory, number>> {
	const response = await client.request(
		INBOX_CATEGORIES.map(({ key }): MethodCall => [
			'Email/query',
			{
				accountId,
				filter: {
					operator: 'AND',
					conditions: [
						{ inMailbox: inboxId },
						{ notKeyword: '$seen' },
						categoryCondition(key)
					]
				},
				calculateTotal: true,
				limit: 0
			},
			key
		])
	);

	const counts = { important: 0, updates: 0, newsletters: 0, promotions: 0 };
	for (const [, result, tag] of response.methodResponses) {
		if (isInboxCategory(tag)) counts[tag] = (result as { total?: number }).total ?? 0;
	}
	return counts;
}

export async function getEmailDetail(
	client: JMAPClient,
	accountId: string,
	id: string
): Promise<Email> {
	const response = await client.request([
		[
			'Email/get',
			{
				accountId,
				ids: [id],
				properties: [
					...LIST_PROPERTIES,
					'htmlBody', 'textBody', 'bodyValues', 'attachments',
					// Threading and reply addressing: In-Reply-To / References on a
					// reply have to carry these Message-IDs (not JMAP ids), and a
					// reply goes to Reply-To when the sender set one.
					'messageId', 'inReplyTo', 'references', 'replyTo',
					// A draft's Bcc, so editing it keeps them.
					'bcc',
					// Raw form: RFC 8621 only allows the Text form for headers RFC 5322
					// and RFC 2369 don't define, and List-Unsubscribe is an RFC 2369
					// header. Stalwart 1.0 rejects `:asText` here (0.15 let it pass).
					// parseListUnsubscribe only reads the <...> entries, so the raw
					// value's leading space and folded lines don't matter.
					'header:list-unsubscribe',
					'header:list-unsubscribe-post:asText',
					'header:x-spam-status:asText',
					'header:x-spam-score:asText',
					// The per-rule breakdown behind the score. A number alone says a
					// message was flagged but not why, and "why" is the only thing
					// that distinguishes a mis-trained classifier from a genuine
					// authentication failure. Not every server emits it; absent
					// header simply renders nothing.
					'header:x-spam-result:asText'
				],
				fetchAllBodyValues: true
			},
			'0'
		]
	]);

	const result = response.methodResponses[0][1] as { list: Email[] };

	if (!result.list.length) {
		throw new Error('Email not found');
	}

	return result.list[0];
}

const IMPORTANCE_HEADERS = {
	high: { importance: 'high', priority: '1 (Highest)' },
	low: { importance: 'low', priority: '5 (Lowest)' }
} as const;

function buildEmailCreate(compose: ComposeEmail): Record<string, unknown> {
	const emailCreate: Record<string, unknown> = {
		from: [compose.from],
		to: compose.to,
		subject: compose.subject,
		// HTML plus a plain-text rendering of it, which the server turns into
		// multipart/alternative. HTML-only mail scores worse with spam filters
		// and shows as nothing in text-only clients and previews.
		bodyValues: {
			body: { value: compose.body, charset: 'utf-8' },
			text: { value: htmlToText(compose.body), charset: 'utf-8' }
		},
		htmlBody: [{ partId: 'body', type: 'text/html' }],
		textBody: [{ partId: 'text', type: 'text/plain' }],
		keywords: { $draft: true, $seen: true }
	};

	if (compose.cc.length > 0) {
		emailCreate.cc = compose.cc;
	}
	if (compose.bcc && compose.bcc.length > 0) {
		emailCreate.bcc = compose.bcc;
	}

	if (compose.attachments && compose.attachments.length > 0) {
		emailCreate.attachments = compose.attachments.map((a: ComposeAttachment) => ({
			blobId: a.blobId,
			type: a.type,
			name: a.name,
			size: a.size,
			disposition: 'attachment'
		}));
	}

	if (compose.sentAt) {
		emailCreate.sentAt = compose.sentAt;
	}

	if (compose.inReplyTo) {
		emailCreate.inReplyTo = [compose.inReplyTo];
	}
	if (compose.references) {
		emailCreate.references = compose.references.split(' ').filter(Boolean);
	}

	// Both headers: Importance is what Outlook and Apple Mail read, X-Priority
	// what older clients do.
	if (compose.importance === 'high' || compose.importance === 'low') {
		const h = IMPORTANCE_HEADERS[compose.importance];
		emailCreate['header:Importance:asText'] = h.importance;
		emailCreate['header:X-Priority:asText'] = h.priority;
	}

	return emailCreate;
}

/**
 * Who the message goes to, as the submission's envelope. Bcc recipients are
 * in it so they receive the message; the stored copy's Bcc header is the
 * server's to strip.
 */
export function buildEnvelope(
	compose: Pick<ComposeEmail, 'to' | 'cc' | 'bcc'>,
	mailFrom: string
): { mailFrom: { email: string }; rcptTo: { email: string }[] } {
	const seen = new Set<string>();
	const rcptTo: { email: string }[] = [];
	for (const a of [...compose.to, ...compose.cc, ...(compose.bcc ?? [])]) {
		const key = a.email.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		rcptTo.push({ email: a.email });
	}
	return { mailFrom: { email: mailFrom }, rcptTo };
}

export interface SendResult {
	success: boolean;
	error?: string;
	/** When the send failed: the draft that now holds the message, so nothing is lost. */
	draftId?: string;
}

/**
 * Send in one request, the way JMAP intends: create the message as a draft,
 * submit it, and only on a successful submission move it to Sent and drop
 * the draft flag (onSuccessUpdateEmail). It used to be created straight in
 * Sent before submitting, so a rejected submission left a copy in Sent that
 * never went anywhere. Now a failure leaves it in Drafts, and its id comes
 * back so the composer keeps working on it. `replaceDraftId` (the draft
 * being sent) is destroyed in the same Email/set.
 */
export async function sendEmail(
	client: JMAPClient,
	accountId: string,
	compose: ComposeEmail,
	mailboxes: { drafts: string; sent: string },
	identity: { id: string; email: string },
	options: { replaceDraftId?: string } = {}
): Promise<SendResult> {
	const emailCreate = buildEmailCreate(compose);
	emailCreate.mailboxIds = { [mailboxes.drafts]: true };

	const response = await client.request([
		[
			'Email/set',
			{
				accountId,
				create: { draft1: emailCreate },
				...(options.replaceDraftId && { destroy: [options.replaceDraftId] })
			},
			'0'
		],
		[
			'EmailSubmission/set',
			{
				accountId,
				create: {
					sub1: {
						emailId: '#draft1',
						identityId: identity.id,
						envelope: buildEnvelope(compose, identity.email)
					}
				},
				// Whole values, not patch paths: Stalwart mishandles some
				// digit-only pointer segments (see updateEmailMailboxes).
				onSuccessUpdateEmail: {
					'#sub1': { mailboxIds: { [mailboxes.sent]: true }, keywords: { $seen: true } }
				}
			},
			'1'
		]
	]);

	const emailResult = response.methodResponses.find(([name, , tag]) => name === 'Email/set' && tag === '0')?.[1] as
		| { created?: Record<string, { id: string }>; notCreated?: Record<string, { type: string; description?: string }> }
		| undefined;
	const submission = response.methodResponses.find(([name]) => name === 'EmailSubmission/set')?.[1] as
		| { created?: Record<string, unknown>; notCreated?: Record<string, { type: string; description?: string }> }
		| undefined;

	if (emailResult?.notCreated?.draft1) {
		const err = emailResult.notCreated.draft1;
		return { success: false, error: err.description ?? err.type ?? 'Failed to create email' };
	}
	const draftId = emailResult?.created?.draft1?.id;
	if (!draftId) return { success: false, error: 'Email created but no ID returned' };

	if (!submission?.created?.sub1) {
		const err = submission?.notCreated ? Object.values(submission.notCreated)[0] : undefined;
		return { success: false, error: err?.description ?? err?.type ?? 'Failed to send email', draftId };
	}
	return { success: true };
}

export type StoredSendResult =
	| { status: 'sent' }
	/** Deleted, moved out of Scheduled, or already sent: nothing to send. */
	| { status: 'gone' }
	| { status: 'failed'; error: string };

/**
 * Send a message that is already stored, waiting in the Scheduled folder.
 * It is submitted as it is (its Date header was set to the send time when it
 * was scheduled), and moved to Sent with its draft flag dropped in the same
 * request, so a message that has left Scheduled has been dealt with.
 */
export async function submitStoredEmail(
	client: JMAPClient,
	accountId: string,
	emailId: string,
	identityId: string,
	envelope: { mailFrom: { email: string }; rcptTo: { email: string }[] },
	mailboxes: { scheduled: string; sent: string }
): Promise<StoredSendResult> {
	const check = await client.request([
		['Email/get', { accountId, ids: [emailId], properties: ['mailboxIds'] }, '0']
	]);
	const found = (check.methodResponses[0][1] as { list?: { mailboxIds?: Record<string, boolean> }[] })
		.list?.[0];
	if (!found?.mailboxIds?.[mailboxes.scheduled]) return { status: 'gone' };

	const response = await client.request([
		[
			'EmailSubmission/set',
			{
				accountId,
				create: { sub1: { emailId, identityId, envelope } },
				onSuccessUpdateEmail: {
					'#sub1': { mailboxIds: { [mailboxes.sent]: true }, keywords: { $seen: true } }
				}
			},
			'0'
		]
	]);
	const submission = response.methodResponses.find(([name]) => name === 'EmailSubmission/set')?.[1] as
		| { created?: Record<string, unknown>; notCreated?: Record<string, { type: string; description?: string }> }
		| undefined;
	if (submission?.created?.sub1) return { status: 'sent' };
	const err = submission?.notCreated?.sub1;
	return { status: 'failed', error: err?.description || err?.type || 'The mail server refused the message' };
}

/**
 * Save a draft. JMAP messages are immutable, so updating a draft means
 * creating its new version and destroying the old one, in one Email/set.
 * Saving used to ignore the previous draft, leaving a duplicate every time.
 */
export async function saveDraft(
	client: JMAPClient,
	accountId: string,
	draftsMailboxId: string,
	compose: ComposeEmail,
	replaceDraftId?: string
): Promise<{ success: boolean; id?: string; error?: string }> {
	const emailCreate = buildEmailCreate(compose);
	emailCreate.mailboxIds = { [draftsMailboxId]: true };

	const response = await client.request([
		[
			'Email/set',
			{
				accountId,
				create: { draft1: emailCreate },
				...(replaceDraftId && { destroy: [replaceDraftId] })
			},
			'0'
		]
	]);

	const result = response.methodResponses[0][1] as {
		created?: Record<string, { id: string }>;
		notCreated?: Record<string, { type: string; description?: string }>;
	};

	if (result.notCreated) {
		const err = Object.values(result.notCreated)[0];
		return { success: false, error: err?.description ?? err?.type ?? 'Failed to save draft' };
	}

	const created = result.created?.draft1;
	return { success: true, id: created?.id };
}

export async function destroyEmail(
	client: JMAPClient,
	accountId: string,
	id: string
): Promise<void> {
	await client.request([
		['Email/set', { accountId, destroy: [id] }, '0']
	]);
}

export async function markEmail(
	client: JMAPClient,
	accountId: string,
	id: string,
	read: boolean
): Promise<void> {
	const response = await client.request([
		[
			'Email/set',
			{
				accountId,
				update: {
					[id]: {
						// `false` (not null) — accepted by every Stalwart version;
						// keyword pointer segments are never digit-only so the
						// patch form is safe here (see updateEmailMailboxes).
						'keywords/$seen': read ? true : false
					}
				}
			},
			'0'
		]
	]);
	assertAllUpdated(response, [id]);
}

/** Toggle the `$flagged` keyword (star) on one email. */
export async function flagEmail(
	client: JMAPClient,
	accountId: string,
	id: string,
	flagged: boolean
): Promise<void> {
	const response = await client.request([
		[
			'Email/set',
			{
				accountId,
				update: {
					[id]: {
						// `false` (not null) — accepted by every Stalwart version;
						// see the note on keywords/$seen above.
						'keywords/$flagged': flagged ? true : false
					}
				}
			},
			'0'
		]
	]);
	assertAllUpdated(response, [id]);
}

/**
 * Put emails in one Inbox tab: its category keyword on, the others off
 * (`false`, as for $seen above). Important clears all three.
 */
export async function setEmailCategory(
	client: JMAPClient,
	accountId: string,
	ids: string[],
	category: InboxCategory
): Promise<void> {
	if (ids.length === 0) return;
	const patch: Record<string, boolean> = {};
	for (const [keyword, on] of Object.entries(categoryKeywordPatch(category))) {
		patch[`keywords/${keyword}`] = on;
	}
	const response = await client.request([
		[
			'Email/set',
			{ accountId, update: Object.fromEntries(ids.map((id) => [id, patch])) },
			'0'
		]
	]);
	assertAllUpdated(response, ids);
}

// ---------------------------------------------------------------------------
// Mailbox membership writes
// ---------------------------------------------------------------------------

/**
 * Mailbox/keyword changes for one email, applied via
 * {@link updateEmailMailboxes}.
 */
export interface EmailMailboxChange {
	/** Mailbox ids to add. */
	add?: string[];
	/** Mailbox ids to remove. */
	remove?: string[];
	/** Keyword → set (true) / clear (false). */
	keywords?: Record<string, boolean>;
}

export interface EmailUpdateFailure {
	id: string;
	type: string;
	description: string;
	properties?: string[];
}

export class EmailUpdateError extends Error {
	constructor(
		message: string,
		public failures: EmailUpdateFailure[]
	) {
		super(message);
		this.name = 'EmailUpdateError';
	}
}

interface EmailSetResult {
	updated?: Record<string, unknown> | null;
	notUpdated?: Record<
		string,
		{ type?: string; description?: string; properties?: string[] }
	> | null;
}

function collectSetFailures(result: EmailSetResult): EmailUpdateFailure[] {
	return Object.entries(result.notUpdated ?? {}).map(([id, err]) => ({
		id,
		type: err.type ?? 'serverFail',
		description: err.description ?? 'rejected by server',
		properties: err.properties
	}));
}

function failureMessage(failures: EmailUpdateFailure[]): string {
	const first = failures[0];
	const where = first.properties?.length ? ` (${first.properties.join(', ')})` : '';
	return `${failures.length} update${failures.length === 1 ? '' : 's'} rejected: ${first.description}${where}`;
}

function assertAllUpdated(response: JMAPResponse, ids: string[]): void {
	const result = response.methodResponses[0][1] as EmailSetResult;
	const failures = collectSetFailures(result);
	if (failures.length > 0) {
		throw new EmailUpdateError(failureMessage(failures), failures);
	}
	void ids;
}

/**
 * Change which mailboxes emails live in by rewriting the **full**
 * `mailboxIds` object, never `mailboxIds/<id>` JSON-pointer patches.
 *
 * Why: Stalwart's JMAP pointer tokenizer (jmap-tools ≤ 0.1.4, shipped in
 * Stalwart v0.15.0–v0.16.7) parses an all-digit pointer segment as an
 * array index, and `handle_email_patch` has no arm for it — the update is
 * rejected with "Invalid patch value". Stalwart's id alphabet
 * ("abcdefghijklmnopqrstuvwxyz792013") routinely yields all-digit mailbox
 * ids (e.g. "9", "92"), so any folder created late enough is unaddressable
 * via patches on those versions. Full-object writes parse map keys with
 * property context on every version, so they always work. Keyword patches
 * keep the pointer form — `$`-prefixed names never tokenize as numbers.
 *
 * Costs one extra Email/get round trip to learn current membership; the
 * read-modify-write race window is negligible for a personal mailbox.
 * Server-side rejections are surfaced as {@link EmailUpdateError} instead
 * of being silently dropped.
 */
export async function updateEmailMailboxes(
	client: JMAPClient,
	accountId: string,
	changes: Record<string, EmailMailboxChange>
): Promise<void> {
	const ids = Object.keys(changes);
	if (ids.length === 0) return;

	const getResponse = await client.request([
		['Email/get', { accountId, ids, properties: ['id', 'mailboxIds'] }, '0']
	]);
	const list =
		((getResponse.methodResponses[0][1] as { list?: { id: string; mailboxIds?: Record<string, boolean> }[] })
			.list ?? []);
	const current = new Map(list.map((e) => [e.id, e.mailboxIds ?? {}]));

	const failures: EmailUpdateFailure[] = [];
	const update: Record<string, Record<string, unknown>> = {};

	for (const id of ids) {
		const cur = current.get(id);
		if (!cur) {
			failures.push({ id, type: 'notFound', description: 'Email no longer exists' });
			continue;
		}
		const change = changes[id];
		const patch: Record<string, unknown> = {};

		if (change.add?.length || change.remove?.length) {
			const next: Record<string, boolean> = { ...cur };
			for (const mb of change.remove ?? []) delete next[mb];
			for (const mb of change.add ?? []) next[mb] = true;
			// JMAP requires at least one mailbox — never strand a message.
			if (Object.keys(next).length === 0) Object.assign(next, cur);

			const changed =
				Object.keys(next).length !== Object.keys(cur).length ||
				Object.keys(next).some((k) => !cur[k]);
			if (changed) patch.mailboxIds = next;
		}

		for (const [keyword, on] of Object.entries(change.keywords ?? {})) {
			patch[`keywords/${keyword}`] = on;
		}

		if (Object.keys(patch).length > 0) update[id] = patch;
	}

	if (Object.keys(update).length > 0) {
		const setResponse = await client.request([
			['Email/set', { accountId, update }, '0']
		]);
		failures.push(...collectSetFailures(setResponse.methodResponses[0][1] as EmailSetResult));
	}

	if (failures.length > 0) {
		throw new EmailUpdateError(failureMessage(failures), failures);
	}
}

export async function moveEmail(
	client: JMAPClient,
	accountId: string,
	id: string,
	targetMailboxId: string,
	sourceMailboxId?: string
): Promise<void> {
	await updateEmailMailboxes(client, accountId, {
		[id]: {
			add: [targetMailboxId],
			remove:
				sourceMailboxId && sourceMailboxId !== targetMailboxId ? [sourceMailboxId] : []
		}
	});
}

/**
 * Move a batch of emails: one Email/get + one Email/set regardless of
 * batch size.
 */
export async function moveEmails(
	client: JMAPClient,
	accountId: string,
	ids: string[],
	targetMailboxId: string,
	sourceMailboxId?: string
): Promise<void> {
	if (ids.length === 0) return;
	const changes: Record<string, EmailMailboxChange> = {};
	for (const id of ids) {
		changes[id] = {
			add: [targetMailboxId],
			remove:
				sourceMailboxId && sourceMailboxId !== targetMailboxId ? [sourceMailboxId] : []
		};
	}
	await updateEmailMailboxes(client, accountId, changes);
}

export const trashEmail = (
	client: JMAPClient, accountId: string, id: string,
	currentMailboxId: string, trashMailboxId: string
) => moveEmail(client, accountId, id, trashMailboxId, currentMailboxId);

export const archiveEmail = (
	client: JMAPClient, accountId: string, id: string,
	currentMailboxId: string, archiveMailboxId: string
) => moveEmail(client, accountId, id, archiveMailboxId, currentMailboxId);

export const spamEmail = (
	client: JMAPClient, accountId: string, id: string,
	currentMailboxId: string, junkMailboxId: string
) => moveEmail(client, accountId, id, junkMailboxId, currentMailboxId);

/**
 * Mark an email as spam: move to Junk AND set the `$junk` IMAP keyword
 * (clearing `$notjunk` if set) so Stalwart's Bayesian classifier can
 * learn from the correction. One Email/set patch updates both at once.
 */
export async function markAsSpam(
	client: JMAPClient,
	accountId: string,
	id: string,
	currentMailboxId: string,
	junkMailboxId: string
): Promise<void> {
	await updateEmailMailboxes(client, accountId, {
		[id]: {
			add: [junkMailboxId],
			remove:
				currentMailboxId && currentMailboxId !== junkMailboxId ? [currentMailboxId] : [],
			keywords: { $junk: true, $notjunk: false }
		}
	});
}

/**
 * Mark an email as NOT spam: move from Junk back to Inbox AND flip the
 * keywords so the classifier learns which direction this message
 * belongs in.
 */
export async function markAsNotSpam(
	client: JMAPClient,
	accountId: string,
	id: string,
	junkMailboxId: string,
	inboxMailboxId: string
): Promise<void> {
	await updateEmailMailboxes(client, accountId, {
		[id]: {
			add: [inboxMailboxId],
			remove: [junkMailboxId],
			keywords: { $junk: false, $notjunk: true }
		}
	});
}

/** Batch version of {@link markAsSpam}. */
export async function markManyAsSpam(
	client: JMAPClient,
	accountId: string,
	ids: string[],
	currentMailboxId: string,
	junkMailboxId: string
): Promise<void> {
	if (ids.length === 0) return;
	const changes: Record<string, EmailMailboxChange> = {};
	for (const id of ids) {
		changes[id] = {
			add: [junkMailboxId],
			remove:
				currentMailboxId && currentMailboxId !== junkMailboxId ? [currentMailboxId] : [],
			keywords: { $junk: true, $notjunk: false }
		};
	}
	await updateEmailMailboxes(client, accountId, changes);
}

/** Batch version of {@link markAsNotSpam}. */
export async function markManyAsNotSpam(
	client: JMAPClient,
	accountId: string,
	ids: string[],
	junkMailboxId: string,
	inboxMailboxId: string
): Promise<void> {
	if (ids.length === 0) return;
	const changes: Record<string, EmailMailboxChange> = {};
	for (const id of ids) {
		changes[id] = {
			add: [inboxMailboxId],
			remove: [junkMailboxId],
			keywords: { $junk: false, $notjunk: true }
		};
	}
	await updateEmailMailboxes(client, accountId, changes);
}

export const forwardEmail = sendEmail;

/**
 * Like `searchEmails` but takes a pre-built JMAP filter tree. Used by the
 * operator-based search parser (Phase 12) which constructs its own tree.
 */
export async function queryAndFetchEmailsWithFilter(
	client: JMAPClient,
	accountId: string,
	filter: Record<string, unknown>,
	options: { position?: number; limit?: number } = {}
): Promise<EmailQueryResult> {
	return searchEmails(client, accountId, filter, options);
}

export async function searchEmails(
	client: JMAPClient,
	accountId: string,
	filter: Record<string, unknown>,
	options: { position?: number; limit?: number } = {}
): Promise<EmailQueryResult> {
	const { position = 0, limit = 50 } = options;

	const response = await client.request([
		[
			'Email/query',
			{
				accountId,
				filter,
				sort: [{ property: 'receivedAt', isAscending: false }],
				position,
				limit,
				calculateTotal: true
			},
			'q'
		],
		[
			'Email/get',
			{
				accountId,
				'#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' },
				properties: LIST_PROPERTIES
			},
			'g'
		]
	]);

	const queryResult = response.methodResponses[0][1] as { total: number };
	const getResult = response.methodResponses[1][1] as { list: Email[] };

	return {
		emails: getResult.list,
		total: queryResult.total
	};
}
