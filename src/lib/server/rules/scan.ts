import type { JMAPClient } from '$lib/jmap/client';
import { getMailboxes } from '$lib/jmap/mailbox';
import { EMAIL_SET_BATCH } from '$lib/jmap/email';
import type { Email, Mailbox } from '$lib/jmap/types';
import type { Rule } from '$lib/types/rules';
import { matcherProperties, ruleContext, updatesForEmails } from './engine';

/**
 * Running rules over the mail already in the Inbox, for the rule editor.
 *
 * The match count ("how many emails match") and "Save & apply" both come
 * from here, so they cannot disagree: each judges the Inbox, newest first,
 * with the matcher the scheduler uses on new mail. The count used to come
 * from the mail server's search over every folder, which is word based and
 * has nothing for "is", "starts with" or "ends with", so it told the owner
 * one number and then the apply moved another.
 */

const PAGE = 200;
const BATCH = EMAIL_SET_BATCH;

export interface ScanResult {
	scanned: number;
	matched: number;
	applied: number;
	failed: number;
	/** The server's reason for the first rejected write, if any. */
	failedReason: string;
	/** Messages in the Inbox when the scan started. */
	total: number;
}

export interface ScanOptions {
	/** Write what the rules do. When false the scan only counts. */
	apply: boolean;
	/** Stop after this many messages. */
	limit?: number;
	/** The account's mailboxes, when the caller has them already. */
	mailboxes?: Mailbox[];
	onProgress?: (result: ScanResult) => void;
	/** Checked before each page: a cancelled scan stops there. */
	cancelled?: () => boolean;
}

interface SetResult {
	updated?: Record<string, unknown> | null;
	notUpdated?: Record<string, { type?: string; description?: string; properties?: string[] }> | null;
}

export async function scanInbox(
	client: JMAPClient,
	accountId: string,
	rules: Rule[],
	opts: ScanOptions
): Promise<ScanResult> {
	const result: ScanResult = { scanned: 0, matched: 0, applied: 0, failed: 0, failedReason: '', total: 0 };
	if (rules.length === 0) return result;

	const mailboxes = opts.mailboxes ?? (await getMailboxes(client, accountId));
	const inbox = mailboxes.find((m) => m.role === 'inbox');
	if (!inbox) return result;
	const ctx = ruleContext(mailboxes);
	result.total = inbox.totalEmails;

	// Send a page of updates in JMAP-safe chunks, counting what the server
	// accepted: `notUpdated` rejections used to be dropped on the floor,
	// reporting success while folders stayed empty. Returns the ids updated.
	const applyUpdates = async (update: Record<string, Record<string, unknown>>): Promise<Set<string>> => {
		const updatedIds = new Set<string>();
		const entries = Object.entries(update);
		for (let i = 0; i < entries.length; i += BATCH) {
			const chunk = Object.fromEntries(entries.slice(i, i + BATCH));
			const setRes = await client.request([['Email/set', { accountId, update: chunk }, '0']]);
			const res = setRes.methodResponses[0][1] as SetResult;
			for (const id of Object.keys(res.updated ?? {})) updatedIds.add(id);
			const rejected = Object.values(res.notUpdated ?? {});
			result.failed += rejected.length;
			if (rejected.length > 0 && !result.failedReason) {
				const first = rejected[0];
				const where = first.properties?.length ? ` (${first.properties.join(', ')})` : '';
				result.failedReason = `${first.description ?? first.type ?? 'rejected by server'}${where}`;
			}
		}
		result.applied += updatedIds.size;
		return updatedIds;
	};

	const { properties, fetchTextBodyValues } = matcherProperties(rules);
	const limit = opts.limit ?? Infinity;
	let position = 0;
	// Bounded loop for safety; the real end is a short page or the limit.
	for (let safety = 0; safety < 10_000 && !opts.cancelled?.() && result.scanned < limit; safety++) {
		const want = Math.min(PAGE, limit - result.scanned);
		const response = await client.request([
			[
				'Email/query',
				{
					accountId,
					filter: { inMailbox: inbox.id },
					sort: [{ property: 'receivedAt', isAscending: false }],
					position,
					limit: want
				},
				'q'
			],
			[
				'Email/get',
				{
					accountId,
					'#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' },
					properties,
					...(fetchTextBodyValues && { fetchTextBodyValues })
				},
				'g'
			]
		]);

		const emails = (response.methodResponses[1][1] as { list: Email[] }).list ?? [];
		if (emails.length === 0) break;

		const page = updatesForEmails(emails, rules, ctx);
		result.scanned += emails.length;
		result.matched += page.matched;
		const updatedIds = opts.apply ? await applyUpdates(page.update) : new Set<string>();
		opts.onProgress?.({ ...result });

		if (emails.length < want) break;
		// A message a move took out of the Inbox has left the listing, so the
		// next page starts that many earlier or it would skip as many unseen
		// messages.
		let left = 0;
		for (const id of updatedIds) {
			const next = page.update[id]?.mailboxIds as Record<string, boolean> | undefined;
			if (next && !next[inbox.id]) left++;
		}
		position += emails.length - left;
	}

	return result;
}
