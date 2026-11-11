import { JMAPAuthError, type JMAPClient } from '$lib/jmap/client';
import { createClient, fetchSession } from '$lib/jmap/auth';
import { getMailboxes } from '$lib/jmap/mailbox';
import type { AuthState, Email } from '$lib/jmap/types';
import { categoryOf } from '$lib/types/categories';
import { hasUnknownMailbox } from '$lib/mailboxes';
import { INBOX_HOLD_MS, isHeld } from '$lib/inbox-hold';
import { getAccount } from '$lib/server/auth/accounts';
import { runAccountTasks } from '$lib/server/account-tasks';
import { AUTO_REPLY_PROPERTIES, answerNewMail } from '$lib/server/auto-reply';
import { evaluateRulesForEmail, extractBodyText, matcherProperties, ruleContext, rulesNeedBody } from '$lib/server/rules/engine';
import { getJevSettings, swapJevSince } from '$lib/server/db/queries/jev-settings';
import { dropNewArrivals, getDecision, listPendingEmailIds, recordFailure } from '$lib/server/db/queries/jev-decisions';
import type { JudgeContext } from '$lib/server/jev/judge';
import { planJevStep, type StepContext, type StepResult } from '$lib/server/jev/step';
import { runBackfill } from '$lib/server/jev/backfill';
import { noteFailure, noteRecovered, rateLimitPaused, retryTypesafe, typesafeFailingFor } from '$lib/server/jev/health';
import { errorFields, logEvent } from '$lib/server/log';
import { pipelineNeeds } from './needs';
import {
	countAttempt,
	discover,
	getCursor,
	keepHoldInStep,
	listUnhandled,
	markHandled,
	MAX_ARRIVAL_ATTEMPTS,
	recordArrivals,
	setCursor,
	type Arrival,
	type ArrivalMailbox
} from './arrivals';
import { addChange, flush, noteWrites, noWrites, type Change, type Flushed, type WriteContext } from './write';

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
 *    arrival is marked handled in the same transaction. With Jev off, only
 *    mail young enough to be held is queued, for the pins.
 * 8. Jev's step: tab, spam and urgent for up to 25 queued messages.
 * 9. The second write: tab, spam move and the "sorted" marker together.
 * 10. Decisions recorded, then urgent alerts.
 * 11. Sorting existing mail, on scheduled passes only.
 *
 * Steps 3 to 7 are the arrivals' handling, and stand on their own: nothing
 * in Jev's step (8 to 11) failing takes them away. A failure there is
 * logged once while it lasts, and what was queued is tried again on the
 * next pass. One message that can't be read costs only itself: the rest
 * are read one at a time. Only a refused password stops everything.
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

	// Since when the Inbox holds new mail: set as the hold is found on,
	// emptied when it is off. Mail from before it is never held (or marked).
	const holdSince = keepHoldInStep(accountRowId, needs.hold, now);

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

	// This pass's arrivals, and any a pass before left part-way. One tried in
	// enough passes already is handled now without out-of-office or the rules,
	// and still goes on to Jev or the pins.
	const unhandled = listUnhandled(accountRowId);
	const givenUp = unhandled.filter((a) => a.attempts >= MAX_ARRIVAL_ATTEMPTS);
	if (givenUp.length) {
		console.warn(`[mail] account ${accountRowId}: gave up on ${givenUp.length} new message(s) after ${MAX_ARRIVAL_ATTEMPTS} failed passes`);
		logEvent('warn', 'mail', 'arrivals_given_up', { account: accountRowId, count: givenUp.length, email_id: givenUp[0].emailId });
	}
	const tried = unhandled.filter((a) => a.attempts < MAX_ARRIVAL_ATTEMPTS);
	countAttempt(accountRowId, tried.map((a) => a.emailId), now);

	// New Inbox mail as it is now, for out-of-office and the rules: only
	// what is still in the Inbox. A message that can't be read is left for
	// the next pass; the others go on.
	const toRead = needs.rules.length > 0 || needs.outOfOffice ? tried.filter((a) => a.mailbox === 'inbox').map((a) => a.emailId) : [];
	let read: Email[] = [];
	let unreadable = new Map<string, unknown>();
	if (toRead.length > 0) {
		const matcher = matcherProperties(needs.rules);
		const properties = needs.outOfOffice ? [...new Set([...matcher.properties, ...AUTO_REPLY_PROPERTIES])] : matcher.properties;
		({ list: read, failed: unreadable } = await readNewMail(client, accountId, toRead, properties, matcher.fetchTextBodyValues));
		if (unreadable.size > 0) {
			const [[emailId, err]] = unreadable;
			noteFailure('read', accountRowId, 'arrival_read_failed', { count: unreadable.size, email_id: emailId, ...errorFields(err) }, 'mail');
		} else {
			noteRecovered('read', accountRowId, 'arrival_read_recovered', 'mail');
		}
	}
	const present = read.filter((e) => e.mailboxIds?.[inbox.id]);
	const presentById = new Map(present.map((e) => [e.id, e]));
	const wasRead = new Set(read.map((e) => e.id));
	// Not read (nothing needed it, or it was given up on): taken to be there.
	const stillInInbox = (emailId: string) => !wasRead.has(emailId) || presentById.has(emailId);
	const arrivals = [...tried.filter((a) => !unreadable.has(a.emailId)), ...givenUp];
	const inboxArrivals = arrivals.filter((a) => a.mailbox === 'inbox');
	const junkArrivals = arrivals.filter((a) => a.mailbox === 'junk');

	// 4. Out-of-office decides on the mail as it arrived, before the rules
	// move it. A failure here never stops the rules.
	if (needs.outOfOffice && present.length) {
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
	if (needs.rules.length > 0 && present.length) {
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
	// switched on. The pass that finds Jev just switched on sends it
	// nothing: it runs as with Jev off. With Jev off, pins still sort the
	// Inbox's new mail, but only mail young enough to be held: after a
	// stretch with no passes, older mail is left where it is.
	const jevOn = needs.jev && !jevJustOn;
	const spamMode = jevOn ? needs.spamMode : 'off';
	const jevSinceMs = jevSince ? Date.parse(jevSince) : null;
	const forJev = (receivedAt: string) =>
		jevOn ? jevSinceMs !== null && Date.parse(receivedAt) >= jevSinceMs : Date.parse(receivedAt) >= now.getTime() - INBOX_HOLD_MS;
	const stepWanted = jevOn ? needs.jevStep : needs.pins.length > 0;
	const queueable = (a: Arrival) =>
		stepWanted &&
		forJev(a.receivedAt) &&
		(a.mailbox === 'junk' ? spamMode !== 'off' && !!junk : stillInInbox(a.emailId) && !movedOut.has(a.emailId));
	const queue = [...inboxArrivals, ...junkArrivals].filter(queueable);

	// The rest of the new Inbox mail the Inbox is holding needs nothing
	// more: marked now, with its rule changes, so it shows at once. Only
	// mail received since the hold was switched on is held.
	const markHeld = (list: Arrival[], queued: Arrival[], into: Map<string, Change>) => {
		if (holdSince === null) return;
		const skip = new Set(queued.map((a) => a.emailId));
		for (const a of list) {
			if (a.mailbox !== 'inbox' || skip.has(a.emailId) || movedOut.has(a.emailId) || !stillInInbox(a.emailId)) continue;
			const email = presentById.get(a.emailId);
			if (!isHeld({ receivedAt: a.receivedAt, keywords: email?.keywords }, now.getTime(), holdSince)) continue;
			addChange(into, a.emailId, { home: inbox.id, tabWas: categoryOf(email?.keywords ?? {}), marker: true });
		}
	};
	markHeld(inboxArrivals, queue, changes);

	/**
	 * A move a rule asked for that the server refused (or never answered)
	 * leaves the message in the Inbox: from here on it is treated like any
	 * other message there, queued and marked.
	 */
	const refusedMoves = (written: Flushed) => {
		const back = inboxArrivals.filter((a) => movedOut.has(a.emailId) && written.notWritten.has(a.emailId));
		for (const a of back) movedOut.delete(a.emailId);
		const queued = back.filter(queueable);
		const markers = new Map<string, Change>();
		markHeld(back, queued, markers);
		return { queued, markers };
	};

	// What may be asked of Jev in this pass. A scheduled pass tries TypeSafe
	// again; a stream pass leaves it alone while it is failing.
	if (!opts.fromStream) retryTypesafe(accountRowId);
	const jevMode: StepContext['jev'] = !jevOn
		? 'off'
		: (opts.fromStream && typesafeFailingFor(accountRowId)) || rateLimitPaused(accountRowId, now.getTime())
			? 'wait'
			: 'ask';
	// While TypeSafe asks for a pause, only pins have anything to do.
	const stepRuns = stepWanted && (jevMode !== 'wait' || needs.pins.length > 0);
	const asksJev = stepRuns && jevMode === 'ask';
	// Jev can be switched off while a pass runs. Look again before each
	// batch, so nothing more is sent once it is.
	const stillOn = () => !jevOn || getJevSettings(accountRowId).jevEnabled;
	const handled = arrivals.map((a) => ({ emailId: a.emailId, rules: fired.get(a.emailId) }));
	const handle = (queued: Arrival[]) => markHandled(accountRowId, handled, queued, now, jevOn);

	let judgeCtx: JudgeContext | null = null;
	const stepCtx: StepContext = {
		client,
		accountId,
		accountRowId,
		inboxId: inbox.id,
		junkId: junk?.id ?? null,
		spamMode,
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
		holdSince,
		now
	};

	// Jev's step never takes the arrivals' handling away: what fails in it
	// is noted once, and the queue is tried again on the next pass. Only a
	// refused password goes on up.
	let stepError: unknown = null;
	const charge: string[] = [];
	const guard = async (part: () => Promise<unknown>) => {
		try {
			await part();
		} catch (err) {
			if (err instanceof JMAPAuthError) throw err;
			stepError ??= err;
		}
	};
	const plan = async (ids: string[]): Promise<StepResult | null> => {
		if (ids.length === 0 || !stillOn()) return null;
		try {
			return await planJevStep(stepCtx, ids, {
				tabs: needs.tabs,
				checkSpam: spamMode !== 'off',
				alertUrgent: jevOn && needs.urgent
			});
		} catch (err) {
			if (err instanceof JMAPAuthError) throw err;
			stepError ??= err;
			charge.push(...ids);
			return null;
		}
	};
	const ids = (queued: Arrival[]) => queued.map((a) => a.emailId);

	if (asksJev) {
		// 6. The rules' changes go out before Jev is called. 7. Then the
		// arrivals are handled, and queued for Jev, together.
		const late = refusedMoves(await flush(write, changes));
		handle([...queue, ...late.queued]);
		// 8 to 10. Jev's step, its write with the marker, the record.
		const second = late.markers;
		const step = await plan(listPendingEmailIds(accountRowId, JUDGE_BATCH));
		for (const [id, change] of step?.changes ?? []) addChange(second, id, change);
		await guard(async () => {
			const written = await flush(write, second);
			await step?.finish(written);
		});
		// 11. Mail that was already in the Inbox when you asked Jev to sort it.
		if (needs.tabs && !opts.fromStream && stillOn()) await guard(() => runBackfill(stepCtx, write));
	} else {
		// Jev isn't asked anything this pass: the rules' changes, the pins'
		// tabs and the marker go out in one write. If the step can't be
		// planned, the rules' changes go out alone.
		const step = stepRuns ? await plan([...new Set([...listPendingEmailIds(accountRowId, JUDGE_BATCH), ...ids(queue)])]) : null;
		for (const [id, change] of step?.changes ?? []) addChange(changes, id, change);
		const written = await flush(write, changes);
		const late = refusedMoves(written);
		handle([...queue, ...late.queued]);
		if (step) await guard(() => step.finish(written));
		// A refused move: the message is in the Inbox after all, so it gets
		// the step (its pin) and the marker in a write of its own.
		if (late.queued.length || late.markers.size) {
			const again = stepRuns ? await plan(ids(late.queued)) : null;
			for (const [id, change] of again?.changes ?? []) addChange(late.markers, id, change);
			await guard(async () => {
				const rewritten = await flush(write, late.markers);
				await again?.finish(rewritten);
			});
		}
	}

	// The step's failure, once while it lasts. The emails it was planning
	// are charged an attempt on a scheduled pass (at most once a minute or
	// so), so a batch that can never be read gives way under Jev's own limit.
	if (stepError) {
		noteFailure('step', accountRowId, 'jev_step_failed', errorFields(stepError), 'mail');
		if (!opts.fromStream) {
			const reason = `Couldn’t be read for Jev: ${errorFields(stepError).error}`;
			for (const id of new Set(charge)) if (getDecision(accountRowId, id)?.status === 'pending') recordFailure(accountRowId, id, reason, now.getTime());
		}
	} else if (stepRuns) {
		noteRecovered('step', accountRowId, 'jev_step_recovered', 'mail');
	}

	noteWrites(accountRowId, write.writes);
}

/**
 * New Inbox mail by id, for out-of-office and the rules. If the batch
 * can't be read, each message is read on its own, so one the server can't
 * give back costs only itself. A refused password still throws.
 */
async function readNewMail(
	client: JMAPClient,
	accountId: string,
	ids: string[],
	properties: string[],
	fetchTextBodyValues: boolean
): Promise<{ list: Email[]; failed: Map<string, unknown> }> {
	const get = async (some: string[]) => {
		const response = await client.request([
			['Email/get', { accountId, ids: some, properties, ...(fetchTextBodyValues && { fetchTextBodyValues: true }) }, 'g']
		]);
		return (response.methodResponses[0][1] as { list?: Email[] }).list ?? [];
	};
	const failed = new Map<string, unknown>();
	try {
		return { list: await get(ids), failed };
	} catch (err) {
		if (err instanceof JMAPAuthError) throw err;
		if (ids.length === 1) return { list: [], failed: failed.set(ids[0], err) };
	}
	const list: Email[] = [];
	for (const id of ids) {
		try {
			list.push(...(await get([id])));
		} catch (err) {
			if (err instanceof JMAPAuthError) throw err;
			failed.set(id, err);
		}
	}
	return { list, failed };
}
