import { JMAPAuthError } from '$lib/jmap/client';
import { createClient, fetchSession } from '$lib/jmap/auth';
import { getMailboxes } from '$lib/jmap/mailbox';
import type { AuthState, Email } from '$lib/jmap/types';
import { categoryOf } from '$lib/types/categories';
import { hasUnknownMailbox } from '$lib/mailboxes';
import { isHeld } from '$lib/inbox-hold';
import { getAccount } from '$lib/server/auth/accounts';
import { runAccountTasks } from '$lib/server/account-tasks';
import { AUTO_REPLY_PROPERTIES, answerNewMail } from '$lib/server/auto-reply';
import { evaluateRulesForEmail, extractBodyText, matcherProperties, ruleContext, rulesNeedBody } from '$lib/server/rules/engine';
import { getJevSettings, swapJevSince } from '$lib/server/db/queries/jev-settings';
import { dropNewArrivals, listPendingEmailIds } from '$lib/server/db/queries/jev-decisions';
import type { JudgeContext } from '$lib/server/jev/judge';
import { planJevStep, type StepContext, type StepResult } from '$lib/server/jev/step';
import { runBackfill } from '$lib/server/jev/backfill';
import { rateLimitPaused, retryTypesafe, typesafeFailingFor } from '$lib/server/jev/health';
import { logEvent } from '$lib/server/log';
import { pipelineNeeds } from './needs';
import {
	countAttempt,
	discover,
	getCursor,
	listUnhandled,
	markHandled,
	MAX_ARRIVAL_ATTEMPTS,
	recordArrivals,
	setCursor,
	type ArrivalMailbox
} from './arrivals';
import { addChange, flush, noteWrites, noWrites, type Change, type WriteContext } from './write';

/**
 * One pass over one account's new mail. In order:
 *
 * 1. What is on (pipelineNeeds). The account's one-time tasks run first,
 *    and never hold the pass up.
 * 2. With nothing on, the cursor moves to now and the mail server isn't
 *    asked anything, so switching something on later never reaches back.
 * 3. Discover: Inbox mail (and Junk, while the spam add-on is on) received
 *    since the cursor, each message recorded once (see arrivals.ts).
 * 4. Out-of-office, on new Inbox mail as it arrived.
 * 5. Rules, in order.
 * 6. The rules' changes are written now, so rules never wait for Jev. When
 *    Jev isn't to be asked anything this pass, they go with the next write.
 * 7. What a rule didn't take out of the Inbox (and Junk mail, while spam is
 *    checked), received since Jev was switched on, is queued for Jev; the
 *    arrival is marked handled in the same transaction.
 * 8. Jev's step: tab, spam and urgent for up to 25 queued messages.
 * 9. The second write: tab, spam move and the "sorted" marker together.
 * 10. Decisions recorded, then urgent alerts.
 * 11. Sorting existing mail, on scheduled passes only.
 *
 * Every write reads again where each message is first (see write.ts).
 */

/** Queued new emails judged per pass. */
const JUDGE_BATCH = 25;

export interface PassOptions {
	/**
	 * Asked for by the account's event stream (see stream.ts), on any change
	 * to its mail, the pass's own writes included. Such a pass leaves mail
	 * already in the Inbox to the once-a-minute run, or each write of a
	 * batch would set off the next one; and while TypeSafe is failing it
	 * doesn't call it, until the next scheduled pass. Rules, out-of-office
	 * and pins still act.
	 */
	fromStream?: boolean;
	/** The pass's clock, for tests. */
	now?: Date;
}

export async function runPass(accountRowId: string, auth: AuthState, opts: PassOptions = {}): Promise<void> {
	const now = opts.now ?? new Date();

	// The account's one-time jobs ride on this pass, which has its
	// credentials. They never hold it up.
	try {
		await runAccountTasks(auth, accountRowId);
	} catch (err) {
		console.error('[mail] account tasks failed', accountRowId, err);
	}

	// 1. What is on.
	const needs = pipelineNeeds(accountRowId, now);
	let jevSince = needs.jevSince;
	let jevJustOn = false;
	if (!needs.jev && jevSince !== null) {
		// Jev is switched on but can't be asked (not configured on the
		// server): what was queued for it is withdrawn, and when it can be
		// asked again it starts from that moment, never from before.
		if (swapJevSince(accountRowId, jevSince, null, now)) dropNewArrivals(accountRowId, now.getTime());
		jevSince = null;
	} else if (needs.jev && jevSince === null) {
		// Jev reads only what arrives from here on: nothing is judged now.
		if (swapJevSince(accountRowId, null, now.toISOString(), now)) dropNewArrivals(accountRowId, now.getTime());
		jevSince = now.toISOString();
		jevJustOn = true;
	}

	// 2. Nothing acts on this account's new mail.
	if (!needs.wantsArrivals) {
		setCursor(accountRowId, now.toISOString(), now);
		return;
	}
	const cursor = getCursor(accountRowId);
	if (cursor === null) {
		// First sight of the account: start from now, so nothing already
		// there is filed, answered or sent to Jev.
		setCursor(accountRowId, now.toISOString(), now);
		return;
	}

	const client = createClient(auth);
	const { accountId } = auth;
	const mailboxes = await getMailboxes(client, accountId);
	const inbox = mailboxes.find((m) => m.role === 'inbox');
	if (!inbox) return;
	// With spam checking on, Junk is watched too: Stalwart's verdicts there
	// are what Jev can confirm, or (in active mode) rescue mail from.
	const junk = needs.spamMode !== 'off' ? (mailboxes.find((m) => m.role === 'junk') ?? null) : null;
	const write: WriteContext = {
		client,
		accountId,
		accountRowId,
		inboxId: inbox.id,
		mailboxes,
		mailboxesRefreshed: false,
		writes: noWrites()
	};

	// 3. Discover, and move the cursor on: what was found is recorded.
	const watched: { mailbox: ArrivalMailbox; id: string }[] = [
		{ mailbox: 'inbox', id: inbox.id },
		...(junk ? [{ mailbox: 'junk' as const, id: junk.id }] : [])
	];
	const { found, nextCursor } = await discover(client, accountId, watched, cursor, now);
	recordArrivals(accountRowId, found, now);
	setCursor(accountRowId, nextCursor, now);

	// This pass's arrivals, and any a pass before left part-way.
	const unhandled = listUnhandled(accountRowId);
	const givenUp = unhandled.filter((a) => a.attempts >= MAX_ARRIVAL_ATTEMPTS);
	if (givenUp.length) {
		markHandled(accountRowId, givenUp.map((a) => ({ emailId: a.emailId })), [], now);
		console.warn(`[mail] account ${accountRowId}: gave up on ${givenUp.length} new message(s) after ${MAX_ARRIVAL_ATTEMPTS} failed passes`);
		logEvent('warn', 'mail', 'arrivals_given_up', { account: accountRowId, count: givenUp.length, email_id: givenUp[0].emailId });
	}
	const arrivals = unhandled.filter((a) => a.attempts < MAX_ARRIVAL_ATTEMPTS);
	countAttempt(accountRowId, arrivals.map((a) => a.emailId));
	const inboxArrivals = arrivals.filter((a) => a.mailbox === 'inbox');
	const junkArrivals = junk ? arrivals.filter((a) => a.mailbox === 'junk') : [];

	// New Inbox mail as it is now, for out-of-office and the rules: only
	// what is still in the Inbox.
	let present: Email[] | null = null;
	if ((needs.rules.length > 0 || needs.outOfOffice) && inboxArrivals.length > 0) {
		const matcher = matcherProperties(needs.rules);
		const properties = needs.outOfOffice ? [...new Set([...matcher.properties, ...AUTO_REPLY_PROPERTIES])] : matcher.properties;
		const response = await client.request([
			[
				'Email/get',
				{
					accountId,
					ids: inboxArrivals.map((a) => a.emailId),
					properties,
					...(matcher.fetchTextBodyValues && { fetchTextBodyValues: true })
				},
				'g'
			]
		]);
		const list = (response.methodResponses[0][1] as { list?: Email[] }).list ?? [];
		present = list.filter((e) => e.mailboxIds?.[inbox.id]);
	}
	const presentById = new Map((present ?? []).map((e) => [e.id, e]));
	const stillInInbox = (emailId: string) => present === null || presentById.has(emailId);

	// 4. Out-of-office decides on the mail as it arrived, before the rules
	// move it. A failure here never stops the rules.
	if (needs.outOfOffice && present?.length) {
		try {
			await answerNewMail(client, accountId, needs.outOfOffice, present, write.mailboxes, now);
		} catch (err) {
			if (err instanceof JMAPAuthError) throw err;
			console.error('[mail] out-of-office failed', accountRowId, err);
		}
	}

	// 5. Rules, in order.
	const changes = new Map<string, Change>();
	const fired = new Map<string, string[]>();
	const movedOut = new Set<string>();
	if (needs.rules.length > 0 && present?.length) {
		// A message in a mailbox the list doesn't know (a label made since it
		// was loaded) needs a fresh list, or a move couldn't tell that label
		// from a folder. Once per pass at most.
		if (hasUnknownMailbox(present.map((e) => e.mailboxIds ?? {}), write.mailboxes)) {
			write.mailboxes = await getMailboxes(client, accountId);
			write.mailboxesRefreshed = true;
		}
		const ctx = ruleContext(write.mailboxes);
		const needBody = rulesNeedBody(needs.rules);
		for (const email of present) {
			const outcome = evaluateRulesForEmail(email, needs.rules, ctx, needBody ? extractBodyText(email) : '');
			if (outcome.firedRuleIds.length === 0) continue;
			fired.set(email.id, outcome.firedRuleIds);
			if (outcome.moveTo !== null && outcome.moveTo !== inbox.id) movedOut.add(email.id);
			changes.set(email.id, { home: inbox.id, tabWas: categoryOf(email.keywords), rules: outcome });
		}
	}

	// 7 (decided here). What Jev is to see: what the rules left in the
	// Inbox, and Junk while spam is checked, received since Jev was
	// switched on. With Jev off, pins still sort the Inbox's new mail.
	const jevSinceMs = jevSince ? Date.parse(jevSince) : null;
	const forJev = (receivedAt: string) => !needs.jev || (jevSinceMs !== null && Date.parse(receivedAt) >= jevSinceMs);
	const queue =
		needs.jevStep && !jevJustOn
			? [
					...inboxArrivals.filter((a) => stillInInbox(a.emailId) && !movedOut.has(a.emailId) && forJev(a.receivedAt)),
					...junkArrivals.filter((a) => forJev(a.receivedAt))
				].map((a) => a.emailId)
			: [];
	const queued = new Set(queue);

	// The rest of the new Inbox mail the Inbox is holding needs nothing
	// more: marked now, with its rule changes, so it shows at once.
	if (needs.hold) {
		for (const a of inboxArrivals) {
			if (queued.has(a.emailId) || movedOut.has(a.emailId) || !stillInInbox(a.emailId)) continue;
			const email = presentById.get(a.emailId);
			if (!isHeld({ receivedAt: a.receivedAt, keywords: email?.keywords }, now.getTime())) continue;
			addChange(changes, a.emailId, { home: inbox.id, tabWas: categoryOf(email?.keywords ?? {}), marker: true });
		}
	}

	// What may be asked of Jev in this pass. A scheduled pass tries TypeSafe
	// again; a stream pass leaves it alone while it is failing.
	if (!opts.fromStream) retryTypesafe(accountRowId);
	const jevMode: StepContext['jev'] = !needs.jev
		? 'off'
		: (opts.fromStream && typesafeFailingFor(accountRowId)) || rateLimitPaused(accountRowId, now.getTime())
			? 'wait'
			: 'ask';
	// While TypeSafe asks for a pause, only pins have anything to do.
	const stepRuns = needs.jevStep && !jevJustOn && (jevMode !== 'wait' || needs.pins.length > 0);
	const asksJev = stepRuns && jevMode === 'ask';
	// Jev can be switched off while a pass runs. Look again before each
	// batch, so nothing more is sent once it is.
	const stillOn = () => !needs.jev || getJevSettings(accountRowId).jevEnabled;
	const handled = arrivals.map((a) => ({ emailId: a.emailId, rules: fired.get(a.emailId) }));

	// 6. The rules' changes go out before Jev is called. 7. Then the
	// arrivals are handled, and queued for Jev, together.
	if (asksJev) {
		await flush(write, changes);
		markHandled(accountRowId, handled, queue, now);
	}

	// 8. Jev's step.
	let judgeCtx: JudgeContext | null = null;
	const stepCtx: StepContext = {
		client,
		accountId,
		accountRowId,
		inboxId: inbox.id,
		junkId: junk?.id ?? null,
		spamMode: needs.spamMode,
		jev: jevMode,
		// Fetched only once there is mail to judge (contacts need the session).
		judge: async () =>
			(judgeCtx ??= {
				accountRowId,
				accountEmail: getAccount(accountRowId)?.email ?? '',
				sentId: write.mailboxes.find((m) => m.role === 'sent')?.id ?? null,
				session: await fetchSession(auth).catch(() => null)
			}),
		pins: needs.pins,
		hold: needs.hold,
		now
	};
	let step: StepResult | null = null;
	if (stepRuns && stillOn()) {
		const pending = listPendingEmailIds(accountRowId, JUDGE_BATCH);
		// Not queued yet when Jev isn't asked: the arrivals are handled after the write.
		const ids = asksJev ? pending : [...new Set([...pending, ...queue])];
		step = await planJevStep(stepCtx, ids, {
			tabs: needs.tabs,
			checkSpam: needs.spamMode !== 'off',
			alertUrgent: needs.urgent
		});
	}

	// 9. The second write: Jev's tab and spam move with the marker, and the
	// rules' changes when they waited for it.
	const second = asksJev ? new Map<string, Change>() : changes;
	for (const [id, change] of step?.changes ?? []) addChange(second, id, change);
	const written = await flush(write, second);
	if (!asksJev) markHandled(accountRowId, handled, queue, now);

	// 10. Record, then alert.
	await step?.finish(written);

	// 11. Mail that was already in the Inbox when you asked Jev to sort it.
	if (asksJev && needs.tabs && !opts.fromStream && stillOn()) await runBackfill(stepCtx, write);

	noteWrites(accountRowId, write.writes);
}
