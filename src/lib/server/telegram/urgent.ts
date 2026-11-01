import type { JevQuestion, JevResponse } from '$lib/server/jev/types';

/**
 * Jev decides what counts as urgent: one more yes-or-no question in the pass
 * it already makes over new Inbox mail, asked only while Telegram alerts are
 * on, so nothing extra is sent to TypeSafe otherwise.
 */

export const URGENT_QUESTION_ID = 'urgent';

export const URGENT_QUESTION: JevQuestion = {
	type: 'noul',
	instructions:
		'The owner of this mailbox should see this email today: a real person or service needs their attention, a reply or an action soon, or it reports something time-critical (a deadline, a security alert, a delivery problem, a meeting change). Newsletters, promotions, routine notifications and receipts are not urgent.'
};

/** Only a confident yes interrupts someone on their phone. */
export const URGENT_THRESHOLD = 0.85;

export function isUrgent(response: JevResponse | null | undefined): boolean {
	const answer = response?.answers?.[URGENT_QUESTION_ID];
	return answer?.type === 'noul' && answer.noul >= URGENT_THRESHOLD;
}
