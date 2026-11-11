import type { JMAPClient } from '$lib/jmap/client';
import { getMailboxes } from '$lib/jmap/mailbox';
import type { Email, Mailbox } from '$lib/jmap/types';
import { categoryKeywordPatch, categoryOf } from '$lib/types/categories';
import type { SpamMode } from '$lib/server/db/queries/jev-settings';
import { pinFor, type SenderPin } from '$lib/server/db/queries/jev-learning';
import { correctedEmailIds, markSkipped, recordFailure } from '$lib/server/db/queries/jev-decisions';
import { emptyOutcome, outcomeToUpdate, type RuleOutcome } from '$lib/server/rules/engine';
import { isHeld, JEV_SORTED_KEYWORD } from '$lib/inbox-hold';
import { hasUnknownMailbox } from '$lib/mailboxes';
import { currentPlacement, writeUpdates, type WriteOutcome } from '$lib/server/mail-pipeline/write';
import { senderAddress } from './facts';
import { fetchEmailsForJev, judgeEmails, notAsked, tabQuestion, type JudgeContext, type JudgedEmail } from './judge';
import { planSpam, SPAM_QUESTIONS } from './spam';
import { decideTab } from './tab';
import { URGENT_QUESTION, URGENT_QUESTION_ID } from './urgent';
import { markTypesafeFailing, noteFailure, noteRecovered, pauseForRateLimit } from './health';
import { recordJudged, sendUrgentAlerts, type Decided } from './record';

/**
 * Jev's step of a pass over new mail: queued emails are fetched, asked
 * everything there is to ask about each in one call, planned (spam first,
 * then the tab), written, recorded, and urgent ones alerted.
 */

export interface Batch {
	client: JMAPClient;
	accountId: string;
	accountRowId: string;
	inboxId: string;
	/** Every mailbox on the account, for the filing rules a move follows. */
	mailboxes: Mailbox[];
	/** Whether `mailboxes` has been fetched again in this pass (at most once). */
	mailboxesRefreshed: boolean;
	/** Watched while spam checking is on. */
	junkId: string | null;
	spamMode: SpamMode;
	/**
	 * What may be asked of Jev in this pass. `ask`: everything. `wait`:
	 * nothing for now (TypeSafe asked for a pause); the mail stays queued.
	 * `off`: nothing, as Jev doesn't read this account; only pins act.
	 */
	jev: 'ask' | 'wait' | 'off';
	judge: () => Promise<JudgeContext>;
	pins: SenderPin[];
	now: Date;
	/** Both batches' writes, logged once for the pass. */
	writes: WriteOutcome;
}

interface Plan extends Decided {
	/** What to do to the message — applied to where it is when it is written. */
	outcome: RuleOutcome;
}

/** A move to Junk or back to the Inbox: like any other move, the message keeps its labels and leaves every other folder. */
function moveOutcome(to: string): RuleOutcome {
	const outcome = emptyOutcome();
	outcome.moveTo = to;
	return outcome;
}

const hasWork = (o: RuleOutcome) => o.moveTo !== null || o.labels.size > 0 || Object.keys(o.keywords).length > 0;

/** The outcome of a tab choice: its keywords, Important meaning none. */
function tabOutcome(tab: Decided['tab']): RuleOutcome {
	const outcome = emptyOutcome();
	if (tab && tab !== 'important') Object.assign(outcome.keywords, categoryKeywordPatch(tab));
	return outcome;
}

/** Judge queued emails, apply what follows, and record it. */
export async function judgeAndApply(
	b: Batch,
	ids: string[],
	wantsTabs: boolean,
	checkSpam: boolean,
	alertUrgent: boolean
): Promise<void> {
	if (ids.length === 0) return;
	const now = b.now.getTime();
	const fetched = new Map((await fetchEmailsForJev(b.client, b.accountId, ids)).map((e) => [e.id, e]));
	const inJunk = (email: Email) => !!b.junkId && !!email.mailboxIds[b.junkId] && !email.mailboxIds[b.inboxId];
	const judgeable: Email[] = [];
	for (const id of ids) {
		const email = fetched.get(id);
		if (email?.mailboxIds[b.inboxId] || (email && checkSpam && inJunk(email))) judgeable.push(email);
		else markSkipped(b.accountRowId, id, now);
	}
	if (judgeable.length === 0) return;

	const pinOf = (email: Email) => pinFor(b.pins, senderAddress(email));
	// Mail you put in a tab yourself keeps it — Important included, which
	// leaves no keyword to see it by, so the record is asked as well.
	const chosen = correctedEmailIds(b.accountRowId, judgeable.map((e) => e.id));
	const tabFor = (email: Email, jevPick: Decided['tab']) =>
		decideTab({ tabsOn: wantsTabs, userChose: chosen.has(email.id), currentTab: categoryOf(email.keywords), pin: pinOf(email), jevPick });
	// Origin evidence goes along only while this batch's spam is checked.
	// When Jev isn't to be asked, nothing is: no facts are gathered either.
	const judged: JudgedEmail[] =
		b.jev === 'ask'
			? await judgeEmails(b.client, b.accountId, judgeable, { ...(await b.judge()), security: checkSpam }, (email) =>
					// Junk mail is only checked for spam: no tab.
					inJunk(email)
						? SPAM_QUESTIONS
						: {
								...(checkSpam ? SPAM_QUESTIONS : {}),
								...(alertUrgent ? { [URGENT_QUESTION_ID]: URGENT_QUESTION } : {}),
								// No point asking for a tab the message already has, or one a pin decides.
								...(tabFor(email, null).open ? tabQuestion() : {})
							}
				)
			: judgeable.map(notAsked);

	const asked = judged.filter((j) => j.facts);
	// TypeSafe failed this whole pass, so no email is charged for it.
	let outage = false;
	if (asked.length && asked.every((j) => j.errorStatus === 429)) {
		// TypeSafe rate-limited every call: it asked for a pause, so this
		// account's queue waits a few minutes instead of knocking again every pass.
		pauseForRateLimit(b.accountRowId, now);
		noteFailure('typesafe', b.accountRowId, 'typesafe_rate_limited', { count: asked.length, error: asked[0].error });
		outage = true;
	} else if (asked.length && asked.every((j) => j.error) && !asked.every((j) => j.refused)) {
		// Every email that was asked failed: TypeSafe is down, not these emails.
		// Charging each an attempt would let a few minutes' outage fail them for
		// good, urgent ones included, so they wait for the next pass instead.
		// A refusal is not an outage, though: TypeSafe answered, and said no to
		// these requests (a 4xx about them, not the key, the model or its load).
		// Every request refused is charged to its email and recorded, or the
		// same mail would be sent again every pass for ever, none of it ever
		// getting its tab, with nothing to say why.
		markTypesafeFailing(b.accountRowId);
		noteFailure('typesafe', b.accountRowId, 'typesafe_unavailable', { count: asked.length, error: asked[0].error });
		outage = true;
	} else {
		if (asked.length) noteRecovered('typesafe', b.accountRowId, 'typesafe_recovered');
		const failed = judged.filter((j) => j.error);
		if (failed.length) noteFailure('judge', b.accountRowId, 'judge_failed', { failed: failed.length, error: failed[0].error });
		else if (b.jev === 'ask') noteRecovered('judge', b.accountRowId, 'judge_recovered');
	}

	// Plan each email. A failed call is retried next run, until it has failed
	// for good. Spam goes first: mail that goes to Junk gets no tab.
	const plans = new Map<string, Plan>();
	const toJunk = new Set<string>();
	for (const j of judged) {
		if (j.error || b.jev === 'wait') {
			// No answer from Jev, for now: the email stays queued. One that failed
			// on its own is charged an attempt; an outage or a rate limit is
			// TypeSafe's doing, not the email's.
			if (j.error && !outage && j.errorStatus !== 429) recordFailure(b.accountRowId, j.email.id, j.error, now);
			// A pinned sender's tab was never Jev's to decide, so it doesn't wait
			// for Jev either: the message goes to its tab now, and shows there.
			// Whatever else was to be asked about it is asked on a later pass.
			const choice = inJunk(j.email) ? null : tabFor(j.email, null);
			if (choice?.pin && categoryOf(j.email.keywords) === 'important') {
				plans.set(j.email.id, { outcome: tabOutcome(choice.tab), tab: choice.tab, pin: choice.pin });
			}
			continue;
		}
		const junked = inJunk(j.email);
		const spam = checkSpam ? planSpam({ answers: j.response?.answers, mode: b.spamMode, inJunk: junked, facts: j.facts }) : { record: null, move: null };
		if (junked) {
			plans.set(j.email.id, {
				outcome: spam.move === 'inbox' && b.junkId ? moveOutcome(b.inboxId) : emptyOutcome(),
				tab: null,
				pin: null,
				spam: spam.record
			});
		} else if (spam.move === 'junk' && b.junkId) {
			toJunk.add(j.email.id);
			plans.set(j.email.id, { outcome: moveOutcome(b.junkId), tab: null, pin: null, spam: spam.record });
		} else {
			const choice = tabFor(j.email, j.decision?.apply ?? null);
			plans.set(j.email.id, { outcome: tabOutcome(choice.tab), tab: choice.tab, pin: choice.pin, spam: spam.record });
		}
	}

	// Done with: the Inbox can stop holding it (see inbox-hold), whatever
	// came of it, Important included. Only mail young enough to be held
	// needs the mark, which spares a write on everything else.
	if (wantsTabs) {
		for (const [id, plan] of plans) {
			const email = fetched.get(id)!;
			const staysInInbox = plan.outcome.moveTo === b.inboxId || (!inJunk(email) && !toJunk.has(id));
			if (staysInInbox && isHeld(email, now)) plan.outcome.keywords[JEV_SORTED_KEYWORD] = true;
		}
	}

	// Apply. The snapshot judged above is minutes old by now: read where each
	// message is, and which tab it has, again, and write only what differs
	// from that, so nothing done to it meanwhile is written over. One that
	// left its mailbox or changed tabs in between was moved by you, or by a
	// rule: it stays as it was put, and Jev's answer is recorded unapplied.
	const withWork = [...plans].filter(([, p]) => hasWork(p.outcome));
	const placement = await currentPlacement(b.client, b.accountId, withWork.map(([id]) => id));
	// The mailbox list is from the start of the pass. A message now in a
	// mailbox it doesn't know (a label made meanwhile) needs a fresh one, or
	// the move couldn't tell that label from a folder. Once per pass at most.
	if (!b.mailboxesRefreshed && hasUnknownMailbox([...placement.values()].map((p) => p.mailboxIds), b.mailboxes)) {
		b.mailboxes = await getMailboxes(b.client, b.accountId);
		b.mailboxesRefreshed = true;
	}
	const updates: [string, Record<string, unknown>][] = [];
	const moved = new Set<string>();
	for (const [id, plan] of withWork) {
		const snapshot = fetched.get(id)!;
		const current = placement.get(id);
		const home = inJunk(snapshot) && b.junkId ? b.junkId : b.inboxId;
		if (!current?.mailboxIds[home] || categoryOf(current.keywords) !== categoryOf(snapshot.keywords)) {
			moved.add(id);
			// Still done with, so a message put in a tab meanwhile isn't held.
			if (plan.outcome.keywords[JEV_SORTED_KEYWORD] && current?.mailboxIds[b.inboxId]) {
				updates.push([id, { [`keywords/${JEV_SORTED_KEYWORD}`]: true }]);
			}
			continue;
		}
		const update = outcomeToUpdate({ ...snapshot, ...current }, plan.outcome, b.mailboxes);
		if (Object.keys(update).length > 0) updates.push([id, update]);
	}
	const notWritten = await writeUpdates(b.client, b.accountId, updates, b.writes);

	recordJudged({
		accountRowId: b.accountRowId,
		judged,
		decided: plans,
		waiting: b.jev === 'wait',
		jevOff: b.jev === 'off',
		notWritten,
		moved,
		now
	});

	if (alertUrgent && b.jev === 'ask') {
		await sendUrgentAlerts(b.accountRowId, judged, (email) => inJunk(email) || toJunk.has(email.id));
	}
}
