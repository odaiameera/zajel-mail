import type { Email } from '$lib/jmap/types';
import type { InboxCategory } from '$lib/types/categories';
import type { SenderPin } from '$lib/server/db/queries/jev-learning';
import { markSkipped, recordDecision, recordFailure } from '$lib/server/db/queries/jev-decisions';
import { flushAlerts, queueUrgent } from '$lib/server/telegram/notifier';
import { errorFields, logEvent } from '$lib/server/log';
import type { JudgedEmail } from './judge';
import type { SpamRecord } from './spam';
import { isUrgent } from './urgent';

/**
 * After the write: what Jev's step did with each email goes into its row
 * in jev_decisions (what the "Why is this here?" chip and Settings read),
 * and urgent mail is sent to Telegram.
 */

/** What the step decided for one email, for the record. */
export interface Decided {
	/** The tab a pin or Jev's pick put it in. */
	tab: InboxCategory | null;
	/** The pin that chose the tab, if one did. */
	pin: SenderPin | null;
	/** Jev's spam answers and what came of them, when spam checking was on. */
	spam?: SpamRecord | null;
}

/**
 * Record each judged email. `notWritten` holds the emails whose write
 * failed, with why; `moved` those you (or a rule) moved meanwhile, whose
 * answer is recorded unapplied. With Jev off (`jevOff`) a pin's doing is
 * the only decision there is: the rest counts as never sorted.
 */
export function recordJudged(opts: {
	accountRowId: string;
	judged: JudgedEmail[];
	decided: Map<string, Decided>;
	/** Mail Jev wasn't asked about this time (TypeSafe asked for a pause): it stays queued. */
	waiting: boolean;
	jevOff: boolean;
	notWritten: Map<string, string>;
	moved: Set<string>;
	now: number;
}): void {
	const { accountRowId, now } = opts;
	for (const j of opts.judged) {
		const plan = opts.decided.get(j.email.id);
		// Failures were recorded already; mail Jev hasn't answered for stays queued.
		if (!plan || j.error || opts.waiting) continue;
		const writeError = opts.notWritten.get(j.email.id);
		if (writeError !== undefined) {
			recordFailure(accountRowId, j.email.id, writeError, now);
			continue;
		}
		// With Jev off, a pin's doing is the only decision there is to record.
		// The rest was let through as it came: it counts as never sorted, so
		// "sort the mail already in your Inbox" offers it if Jev is switched on.
		if (opts.jevOff && !plan.pin) {
			markSkipped(accountRowId, j.email.id, now);
			continue;
		}
		const applied = !opts.moved.has(j.email.id);
		recordDecision(
			accountRowId,
			j.email.id,
			{
				category: plan.pin ? plan.pin.category : (j.decision?.category ?? null),
				confidence: plan.pin ? null : (j.decision?.confidence ?? null),
				applied: applied ? plan.tab : null,
				pinnedBy: plan.pin?.sender ?? null,
				answers: j.response?.answers ?? {},
				facts: j.facts ?? {},
				model: j.response?.model ?? null,
				inputTokens: j.response?.usage.inputTokens ?? 0,
				spam: plan.spam ? { ...plan.spam, action: applied ? plan.spam.action : null } : null
			},
			now
		);
	}
}

/**
 * Urgent Inbox mail goes to the linked Telegram chat; never Junk, or mail
 * on its way there (`skip`). Every alert is queued before any is sent: the
 * emails are already marked done, so one not queued before a crash would
 * never be alerted. An email is only ever alerted once (see queueUrgent).
 */
export async function sendUrgentAlerts(accountRowId: string, judged: JudgedEmail[], skip: (email: Email) => boolean): Promise<void> {
	const flushFor = new Set<string>();
	for (const j of judged) {
		if (j.error || skip(j.email) || !isUrgent(j.response)) continue;
		try {
			const userId = queueUrgent(accountRowId, j.email);
			if (userId) flushFor.add(userId);
		} catch (err) {
			console.error('[jev] urgent alert failed', err instanceof Error ? err.message : err);
			logEvent('error', 'jev', 'urgent_alert_failed', { account: accountRowId, ...errorFields(err) });
		}
	}
	for (const userId of flushFor) {
		await flushAlerts(userId).catch((err) => logEvent('error', 'jev', 'urgent_alert_failed', { account: accountRowId, ...errorFields(err) }));
	}
}
