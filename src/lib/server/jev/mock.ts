import { INBOX_CATEGORIES, type InboxCategory } from '$lib/types/categories';
import type { JevEmailState } from './email-state';
import type { JevAnswer, JevQuestion, JevResponse } from './types';

/**
 * JEV_MOCK: answers produced locally from the facts we would have sent, so
 * the whole flow (the new-mail pass, tabs, the tab chip, the preview) runs
 * without an API key or sending mail anywhere. Every answer comes back
 * marked `mock`, and the UI says so; a mock pick is a rule of thumb, not Jev.
 */

const PROMO_WORDS = /\b(?:sale|deals?|offers?|discount|save|free|coupon|reward|% off|limited time|upgrade)\b/i;

/** The rule of thumb behind mock category answers. */
export function mockCategory(state: JevEmailState): InboxCategory {
	const { facts, email } = state;
	// Your own moves first: the tab you moved this sender's mail to most.
	const habit = facts.sender_history?.match(/ to (Important|Updates|Newsletters|Promotions)\b/);
	if (habit) return habit[1].toLowerCase() as InboxCategory;
	if (facts.sender_in_contacts || facts.you_have_written_in_this_thread) return 'important';
	if (facts.contains_sign_in_code) return 'updates';
	const bulk = facts.has_list_unsubscribe || !!facts.list_id || facts.bulk_precedence;
	if (bulk && PROMO_WORDS.test(email.subject)) return 'promotions';
	if (bulk) return 'newsletters';
	if (facts.sender_looks_automated || facts.auto_submitted) return 'updates';
	return 'important';
}

const STOP_WORDS = new Set([
	'this', 'that', 'email', 'message', 'mail', 'about', 'from', 'with', 'they', 'them', 'their',
	'there', 'have', 'been', 'which', 'what', 'when', 'would', 'could', 'should', 'some', 'into',
	'asks', 'asking', 'sent', 'someone', 'something', 'like', 'just', 'your', 'mine'
]);

/**
 * The rule of thumb behind mock `noul` answers: likely (0.9) when one of the
 * statement's content words appears in the subject or body, unlikely (0.1)
 * otherwise — enough to exercise a yes-or-no question end to end without Jev.
 */
export function mockStatementProbability(statement: string, state: JevEmailState): number {
	const text = `${state.email.subject} ${state.email.body_excerpt}`.toLowerCase();
	const words = (statement.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((w) => !STOP_WORDS.has(w));
	return words.some((w) => text.includes(w.replace(/(?:es|s)$/, ''))) ? 0.9 : 0.1;
}

/**
 * The rules of thumb behind mock spam answers: spam follows Stalwart's own
 * verdict; phishing follows a sender that hides behind another domain.
 */
function mockSpamProbability(state: JevEmailState): number {
	const sec = state.facts.security;
	if (sec?.stalwart_flagged) return 0.95;
	return state.facts.has_list_unsubscribe ? 0.2 : 0.05;
}

function mockPhishingProbability(state: JevEmailState): number {
	const sec = state.facts.security;
	return sec && (sec.display_name_mismatch || sec.reply_to_differs) ? 0.92 : 0.02;
}

/** TypeSafe's planning estimate: ~300 overhead + chars/4 + ~50 per question. */
function estimateInputTokens(state: unknown, questionCount: number): number {
	return Math.round(300 + JSON.stringify(state).length / 4 + 50 * questionCount);
}

function isEmailState(state: unknown): state is JevEmailState {
	const s = state as JevEmailState | null;
	return !!s && typeof s === 'object' && !!s.email && !!s.facts;
}

function choiceAnswer(options: string[], pick: string): JevAnswer {
	const rest = (1 - 0.85) / Math.max(1, options.length - 1);
	const probabilities = Object.fromEntries(options.map((o) => [o, o === pick ? 0.85 : rest]));
	const even = 1 / options.length;
	return {
		type: 'choice',
		choice: pick,
		probabilities,
		confidence: Math.round(((0.85 - even) / (1 - even)) * 100) / 100
	};
}

export function mockJev(state: unknown, questions: Record<string, JevQuestion>): JevResponse {
	const categoryKeys = INBOX_CATEGORIES.map((c) => c.key as string);
	const answers: Record<string, JevAnswer> = {};
	for (const [id, question] of Object.entries(questions)) {
		if (question.type === 'choice') {
			const options = Object.keys(question.criteria);
			const isCategory = categoryKeys.every((k) => options.includes(k));
			const pick = isCategory && isEmailState(state) ? mockCategory(state) : options[0];
			answers[id] = choiceAnswer(options, pick);
		} else if (question.type === 'noul') {
			const noul = !isEmailState(state)
				? 0.5
				: id === 'spam'
					? mockSpamProbability(state)
					: id === 'phishing'
						? mockPhishingProbability(state)
						: mockStatementProbability(question.instructions, state);
			answers[id] = { type: 'noul', noul };
		} else {
			const levels = question.criteria.map((_, i) => String(i));
			const middle = Math.floor(levels.length / 2);
			answers[id] = {
				type: 'score',
				score: middle,
				legend: Object.fromEntries(question.criteria.map((c, i) => [String(i), c])),
				probabilities: Object.fromEntries(levels.map((l) => [l, l === String(middle) ? 1 : 0])),
				confidence: 1
			};
		}
	}
	return {
		model: 'mock',
		answers,
		usage: { inputTokens: estimateInputTokens(state, Object.keys(questions).length), outputTokens: 0 },
		mock: true
	};
}
