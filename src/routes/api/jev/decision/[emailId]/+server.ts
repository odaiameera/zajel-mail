import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDecision } from '$lib/server/db/queries/jev-decisions';
import { CATEGORY_QUESTION_ID } from '$lib/server/jev/categorize';
import { matchedRuleIds } from '$lib/server/mail-pipeline/arrivals';
import { listRules } from '$lib/server/rules/store';
import { isInboxCategory } from '$lib/types/categories';
import { tabWhy } from '$lib/tab-reason';

/**
 * Why one email of the active account is in its Inbox tab, for the tab chip
 * in the message view:
 *
 * - `why`: for the tab named by `?tab=` (the one the message is in now),
 *   your own choice, a pin or Jev's pick, whichever is recorded for that
 *   tab (see `tabWhy`); null without a tab.
 * - `rules`: the names of the rules that matched it when it arrived, in
 *   their order, of those that still exist. Arrivals are kept for a week,
 *   so older mail has none.
 * - `decision`: what Jev decided, if it answered: its tab pick, how sure it
 *   was, the probabilities, and the facts that were sent with the email.
 *
 * Everything is read under the active account, so another account's
 * message id finds nothing of that account's.
 */
export const GET: RequestHandler = async ({ params, locals, url }) => {
	if (!locals.auth || !locals.activeAccountId) {
		return json({ error: 'Not authenticated' }, { status: 401 });
	}

	const accountId = locals.activeAccountId;
	const row = getDecision(accountId, params.emailId);
	const tab = url.searchParams.get('tab');
	const why = isInboxCategory(tab) ? tabWhy(row, tab) : null;
	const matched = new Set(matchedRuleIds(accountId, params.emailId));
	const rules = matched.size ? [...new Set(listRules(accountId).filter((r) => matched.has(r.id)).map((r) => r.name))] : [];

	if (!row || row.status !== 'done' || (!row.category && row.spam === null)) {
		return json({ decision: null, why, rules });
	}

	const answer = row.answers?.[CATEGORY_QUESTION_ID] as
		| { probabilities?: Record<string, number> }
		| undefined;
	return json({
		decision: {
			category: row.category,
			confidence: row.confidence,
			applied: row.applied,
			correctedTo: row.correctedTo,
			probabilities: answer?.probabilities ?? {},
			facts: row.facts ?? {},
			pinnedBy: row.pinnedBy,
			spamCheck:
				row.spam === null
					? null
					: {
							spam: row.spam,
							phishing: row.phishing,
							stalwartSpam: row.stalwartSpam,
							action: row.spamAction,
							correctedTo: row.spamCorrectedTo
						},
			model: row.model,
			mock: row.model === 'mock',
			decidedAt: row.decidedAt
		},
		why,
		rules
	});
};
