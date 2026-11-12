import type { JMAPClient } from '$lib/jmap/client';
import type { Email, JMAPSession } from '$lib/jmap/types';
import { senderHistory } from '$lib/server/db/queries/jev-learning';
import { addUsage } from '$lib/server/db/queries/jev-decisions';
import { askJev, JevError } from './client';
import { CATEGORY_QUESTION, CATEGORY_QUESTION_ID, decideCategory, type CategoryDecision } from './categorize';
import { buildEmailState, type JevFacts } from './email-state';
import { gatherFacts } from './facts';
import type { JevQuestion, JevResponse } from './types';

/**
 * Asking Jev about emails: fetching each with everything its state and
 * facts are built from, and one call per email holding every question
 * there is for it. Used by the new-mail pipeline's Jev step and by the
 * previews ("Try Jev" in Settings).
 */

/** How many of the newest Inbox emails "Try Jev" judges. */
export const PREVIEW_LIMIT = 200;
/** Body bytes fetched per email — comfortably more than the excerpt needs. */
const MAX_BODY_BYTES = 16_000;
/** Parallel calls to TypeSafe per account. */
const CONCURRENCY = 4;

export const JEV_EMAIL_PROPERTIES = [
	'id', 'threadId', 'mailboxIds', 'keywords',
	'from', 'to', 'cc', 'subject', 'receivedAt', 'preview',
	'size', 'hasAttachment',
	'textBody', 'htmlBody', 'bodyValues',
	// Raw form: Stalwart 1.0 rejects `:asText` for this RFC 2369 header.
	'header:list-unsubscribe',
	'header:list-id:asText',
	'header:precedence:asText',
	'header:auto-submitted:asText',
	// Spam evidence, used while spam checking is on.
	'replyTo',
	'header:authentication-results:asText:all',
	'header:x-spam-status:asText',
	'header:x-spam-score:asText',
	'header:x-spam-result:asText'
];

/** Fetch emails with everything the state and facts are built from. */
export async function fetchEmailsForJev(
	client: JMAPClient,
	accountId: string,
	ids: string[]
): Promise<Email[]> {
	if (ids.length === 0) return [];
	const response = await client.request([
		[
			'Email/get',
			{
				accountId,
				ids,
				properties: JEV_EMAIL_PROPERTIES,
				fetchTextBodyValues: true,
				fetchHTMLBodyValues: true,
				maxBodyValueBytes: MAX_BODY_BYTES
			},
			'g'
		]
	]);
	return (response.methodResponses[0][1] as { list?: Email[] }).list ?? [];
}

/** Run `fn` over `items`, at most `limit` at a time, keeping order. */
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const out: R[] = new Array(items.length);
	let next = 0;
	async function lane() {
		while (next < items.length) {
			const i = next++;
			out[i] = await fn(items[i]);
		}
	}
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
	return out;
}

export interface JudgedEmail {
	email: Email;
	/** Null when there was nothing to ask, so Jev wasn't called. */
	facts: JevFacts | null;
	response: JevResponse | null;
	/** The tab decision, when the tab was asked about. */
	decision: CategoryDecision | null;
	error: string | null;
	/** TypeSafe's status for a failed call: 429 means it is busy, not that the email is bad. */
	errorStatus?: number;
	/** TypeSafe refused this very request: a 4xx that is not about the key, the model or its load. */
	refused?: boolean;
}

export interface JudgeContext {
	/** The linked account row — usage is counted against it. */
	accountRowId: string;
	accountEmail: string;
	sentId: string | null;
	session: JMAPSession | null;
	/** Send origin evidence and Stalwart's verdict (spam checking on). */
	security?: boolean;
}

/** The judge context for an account, with your sender history attached. */
function withHistory(ctx: JudgeContext) {
	return { ...ctx, senderHistory: (sender: string) => senderHistory(ctx.accountRowId, sender) };
}

/** Just the Inbox tab. */
export const tabQuestion = (): Record<string, JevQuestion> => ({ [CATEGORY_QUESTION_ID]: CATEGORY_QUESTION });

/** An email nobody asked about: nothing gathered, nothing answered. */
export const notAsked = (email: Email): JudgedEmail => ({ email, facts: null, response: null, decision: null, error: null });

/**
 * Ask Jev each email's questions — by default just the Inbox tab. Emails
 * with nothing to ask aren't sent. Shared by the pipeline and the previews;
 * a failed call becomes `error` on that email, never a throw.
 */
export async function judgeEmails(
	client: JMAPClient,
	accountId: string,
	emails: Email[],
	ctx: JudgeContext,
	questionsFor: (email: Email) => Record<string, JevQuestion> = tabQuestion
): Promise<JudgedEmail[]> {
	const questions = new Map(emails.map((e) => [e.id, questionsFor(e)]));
	const asking = emails.filter((e) => Object.keys(questions.get(e.id)!).length > 0);
	const facts = await gatherFacts(client, accountId, asking, withHistory(ctx));
	return mapPool(emails, CONCURRENCY, async (email): Promise<JudgedEmail> => {
		const emailQuestions = questions.get(email.id)!;
		const emailFacts = facts.get(email.id) ?? null;
		if (!emailFacts) return notAsked(email);
		try {
			const response = await askJev(buildEmailState(email, emailFacts), emailQuestions);
			if (!response.mock) addUsage(ctx.accountRowId, response.usage.inputTokens);
			return {
				email,
				facts: emailFacts,
				response,
				decision: emailQuestions[CATEGORY_QUESTION_ID]
					? decideCategory(response.answers[CATEGORY_QUESTION_ID])
					: null,
				error: null
			};
		} catch (err) {
			const upstream = err instanceof JevError ? err.upstream : null;
			return {
				email,
				facts: emailFacts,
				response: null,
				decision: null,
				error: err instanceof Error ? err.message : String(err),
				errorStatus: err instanceof JevError ? err.status : undefined,
				refused: upstream !== null && upstream >= 400 && upstream < 500 && ![401, 403, 404, 429].includes(upstream)
			};
		}
	});
}
