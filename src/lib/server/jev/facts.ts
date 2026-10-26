import type { JMAPClient } from '$lib/jmap/client';
import type { Email, JMAPSession, MethodCall } from '$lib/jmap/types';
import { CONTACTS_CAPABILITY, resolveContactsAccount } from '$lib/jmap/contacts';
import { cardHasAddress, normalizeAddress } from '$lib/server/trust-sender';
import { detectVerificationCode } from '$lib/utils/otp';
import { bodyExcerpt, type JevFacts } from './email-state';
import { securityFacts } from './spam';

/**
 * The facts sent to Jev beside each email (see `JevFacts`). Header facts
 * are read off the message; the rest ask the mail server, in as few
 * requests as possible, and degrade to `null` — "couldn't tell" — rather
 * than failing the email when a lookup does.
 */

/** Senders per request: two calls each, inside common maxCallsInRequest. */
const SENDER_CHUNK = 8;
const THREAD_CHUNK = 50;

const NOREPLY = /^(?:no[-_.]?reply|do[-_.]?not[-_.]?reply|notifications?|alerts?|mailer-daemon|bounces?)(?:[-+_.].*)?$/i;

export function senderAddress(email: Email): string {
	return normalizeAddress(email.from?.[0]?.email ?? '');
}

/** Facts read straight off the message. */
export function headerFacts(
	email: Email,
	accountEmail: string
): Omit<
	JevFacts,
	'sender_in_contacts' | 'you_have_written_to_sender' | 'you_have_written_in_this_thread' | 'sender_history'
> {
	const me = normalizeAddress(accountEmail);
	const precedence = (email['header:precedence:asText'] ?? '').trim().toLowerCase();
	const autoSubmitted = (email['header:auto-submitted:asText'] ?? '').trim().toLowerCase();
	const localPart = senderAddress(email).split('@')[0] ?? '';
	return {
		addressed_to_you_directly: (email.to ?? []).some((a) => normalizeAddress(a.email) === me),
		has_list_unsubscribe: !!email['header:list-unsubscribe']?.trim(),
		list_id: email['header:list-id:asText']?.trim() || null,
		bulk_precedence: ['bulk', 'list', 'junk'].includes(precedence),
		auto_submitted: autoSubmitted !== '' && autoSubmitted !== 'no',
		sender_looks_automated: NOREPLY.test(localPart),
		contains_sign_in_code: !!detectVerificationCode(email.subject ?? '', bodyExcerpt(email))
	};
}

function chunk<T>(items: T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
	return out;
}

/** Senders you have sent mail to, by a count-only query on Sent. */
async function sendersYouWroteTo(
	client: JMAPClient,
	accountId: string,
	sentId: string,
	senders: string[]
): Promise<Map<string, boolean | null>> {
	const out = new Map<string, boolean | null>();
	for (const group of chunk(senders, SENDER_CHUNK * 2)) {
		try {
			const response = await client.request(
				group.map((address, i): MethodCall => [
					'Email/query',
					{ accountId, filter: { inMailbox: sentId, to: address }, limit: 0, calculateTotal: true },
					String(i)
				])
			);
			for (const [, result, tag] of response.methodResponses) {
				out.set(group[Number(tag)], ((result as { total?: number }).total ?? 0) > 0);
			}
		} catch {
			for (const address of group) out.set(address, null);
		}
	}
	return out;
}

/** Threads holding at least one message from Sent — conversations you're in. */
async function threadsYouWroteIn(
	client: JMAPClient,
	accountId: string,
	sentId: string,
	threadIds: string[]
): Promise<Set<string> | null> {
	const out = new Set<string>();
	try {
		for (const group of chunk(threadIds, THREAD_CHUNK)) {
			const response = await client.request([
				['Thread/get', { accountId, ids: group }, 't'],
				[
					'Email/get',
					{
						accountId,
						'#ids': { resultOf: 't', name: 'Thread/get', path: '/list/*/emailIds' },
						properties: ['id', 'threadId', 'mailboxIds']
					},
					'e'
				]
			]);
			const list =
				(response.methodResponses[1][1] as {
					list?: { threadId: string; mailboxIds: Record<string, boolean> }[];
				}).list ?? [];
			for (const e of list) if (e.mailboxIds[sentId]) out.add(e.threadId);
		}
		return out;
	} catch {
		return null;
	}
}

/** Senders already in the address book — the same test trust-sender uses. */
async function sendersInContacts(
	client: JMAPClient,
	session: JMAPSession | null,
	senders: string[]
): Promise<Map<string, boolean | null>> {
	const out = new Map<string, boolean | null>(senders.map((s) => [s, null]));
	if (!session) return out;
	let contactsAccountId: string;
	try {
		contactsAccountId = resolveContactsAccount(session).accountId;
	} catch {
		return out; // No contacts on this server: unknown, not "no".
	}
	const using = ['urn:ietf:params:jmap:core', CONTACTS_CAPABILITY];
	for (const group of chunk(senders, SENDER_CHUNK)) {
		try {
			const calls: MethodCall[] = group.flatMap((address, i): MethodCall[] => [
				['ContactCard/query', { accountId: contactsAccountId, filter: { text: address }, limit: 20 }, `q${i}`],
				[
					'ContactCard/get',
					{
						accountId: contactsAccountId,
						'#ids': { resultOf: `q${i}`, name: 'ContactCard/query', path: '/ids' },
						properties: ['emails']
					},
					`g${i}`
				]
			]);
			const response = await client.request(calls, using);
			for (const [name, result, tag] of response.methodResponses) {
				if (name !== 'ContactCard/get') continue;
				const address = group[Number(tag.slice(1))];
				const cards = (result as { list?: { emails?: unknown }[] }).list ?? [];
				out.set(address, cards.some((card) => cardHasAddress(card.emails, address)));
			}
		} catch {
			// Leave this group unknown.
		}
	}
	return out;
}

/**
 * Facts for a batch of emails from one account. `session` is only needed
 * for the contacts lookup; pass null to skip it. `senderHistory` says where
 * you have moved a sender's mail before (see jev-learning.ts).
 */
export async function gatherFacts(
	client: JMAPClient,
	accountId: string,
	emails: Email[],
	ctx: {
		accountEmail: string;
		sentId: string | null;
		session: JMAPSession | null;
		senderHistory?: (sender: string) => string | null;
		/** Add origin evidence and Stalwart's verdict (spam checking on). */
		security?: boolean;
	}
): Promise<Map<string, JevFacts>> {
	const senders = [...new Set(emails.map(senderAddress).filter(Boolean))];
	const threadIds = [...new Set(emails.map((e) => e.threadId).filter(Boolean))];

	const [wroteTo, threads, contacts] = await Promise.all([
		ctx.sentId ? sendersYouWroteTo(client, accountId, ctx.sentId, senders) : null,
		ctx.sentId ? threadsYouWroteIn(client, accountId, ctx.sentId, threadIds) : null,
		sendersInContacts(client, ctx.session, senders)
	]);

	const facts = new Map<string, JevFacts>();
	for (const email of emails) {
		const sender = senderAddress(email);
		facts.set(email.id, {
			sender_in_contacts: contacts.get(sender) ?? null,
			you_have_written_to_sender: wroteTo?.get(sender) ?? null,
			you_have_written_in_this_thread: threads ? threads.has(email.threadId) : null,
			...headerFacts(email, ctx.accountEmail),
			sender_history: sender ? (ctx.senderHistory?.(sender) ?? null) : null,
			...(ctx.security ? { security: securityFacts(email) } : {})
		});
	}
	return facts;
}
