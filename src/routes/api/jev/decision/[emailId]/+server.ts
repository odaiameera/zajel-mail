import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDecision } from '$lib/server/db/queries/jev-decisions';
import { CATEGORY_QUESTION_ID } from '$lib/server/jev/categorize';

/**
 * What Jev decided about one email of the active account, for the "Why is
 * this here?" chip: its tab pick, how sure it was, the probabilities, and
 * the facts that were sent with the email. `decision: null` when Jev never
 * answered for it.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.auth || !locals.activeAccountId) {
		return json({ error: 'Not authenticated' }, { status: 401 });
	}

	const row = getDecision(locals.activeAccountId, params.emailId);
	if (!row || row.status !== 'done' || (!row.category && row.spam === null)) {
		return json({ decision: null });
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
		}
	});
};
