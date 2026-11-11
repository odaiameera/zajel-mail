import cron from 'node-cron';
import { listSchedulableAuths, markNeedsReauth } from '$lib/server/auth/accounts';
import { JMAPAuthError } from '$lib/jmap/client';
import { createClient, fetchSession } from '$lib/jmap/auth';
import { getMailboxes } from '$lib/jmap/mailbox';
import type { AuthState, MethodCall } from '$lib/jmap/types';
import { isRunnable } from '$lib/types/rules';
import {
	advanceSortCursor,
	getJevSettings,
	updateJevSettings,
	type SpamMode
} from '$lib/server/db/queries/jev-settings';
import { listRules } from '$lib/server/rules/store';
import { listPins } from '$lib/server/db/queries/jev-learning';
import { dropNewArrivals, enqueueEmails, listPendingEmailIds } from '$lib/server/db/queries/jev-decisions';
import { jevMode } from './client';
import { urgentAlertsWanted } from '$lib/server/telegram/notifier';
import { errorFields } from '$lib/server/log';
import { INBOX_HOLD_MS } from '$lib/inbox-hold';
import { noWrites, noteWrites } from '$lib/server/mail-pipeline/write';
import type { JudgeContext } from './judge';
import { judgeAndApply, type Batch } from './step';
import { runBackfill } from './backfill';
import { noteFailure, noteRecovered, rateLimitPaused, retryTypesafe, typesafeFailingFor } from './health';
import { startJevWatchers } from './stream';
import { applyRulesNow } from '$lib/server/rules-scheduler';

/**
 * Sorting new Inbox mail into its tab a beat after it lands: within seconds,
 * from each account's push stream (see stream.ts), and as a fallback the
 * same shape as the rules scheduler — every minute, plus a catch-up for
 * whoever is using the app.
 *
 * Two things put new mail in a tab. Your sender pins do whenever the Inbox
 * has tabs, with Jev on, off or unreachable: a pin is your decision, and
 * nothing is asked of anyone. Jev does for the accounts that let it read
 * their mail, and only mail that arrived after that was switched on is ever
 * sent to it.
 *
 * Each email Jev reads gets one call holding everything there is to ask:
 * the Inbox tab (when tabs are on and no pin decides it), and the spam and
 * urgency questions when those are on. Rules are not Jev's: the rules
 * scheduler runs them, and a pass asks it for a run before it sorts, so a
 * rule's move or label is in place first and never waits on TypeSafe.
 *
 * Arrivals are queued in jev_decisions and judged from the queue: an email
 * whose call fails is retried on the next run, and given up on after
 * MAX_JEV_ATTEMPTS. The cursor keeps moving for everything else.
 */

/** New arrivals queued per run. */
const QUEUE_PAGE = 100;
// How far each pass looks back past its own start; see the cursor below.
const CURSOR_LOOKBACK_MS = 60_000;
/** Queued new emails judged per run. */
const JUDGE_BATCH = 25;

export interface PassOptions {
	/**
	 * Asked for by the account's push stream (see stream.ts), on any change
	 * to its mail, Jev's own writes included. Such a pass judges new mail
	 * only, leaving mail already in the Inbox to the once-a-minute run, or
	 * each write of a batch would set off the next one. And while TypeSafe
	 * is failing it does nothing at all, until the next scheduled pass.
	 */
	fromStream?: boolean;
}

/** One triage pass for one account: queue arrivals, judge, apply, record. */
export async function sortNewMail(
	accountRowId: string,
	accountEmail: string,
	auth: AuthState,
	now = new Date(),
	opts: PassOptions = {}
): Promise<void> {
	const settings = getJevSettings(accountRowId);
	const wantsTabs = settings.inboxTabs;
	// Whether Jev may be asked about this account's mail at all.
	const jevOn = settings.jevEnabled && jevMode() !== 'off';
	// Sender pins are yours, not Jev's: with tabs on they put a sender's new
	// mail in its tab whether Jev is on, off or can't be reached. (The Inbox
	// holds new mail for exactly these passes: see inboxHoldOn.)
	const pins = wantsTabs ? listPins(accountRowId) : [];
	if (!jevOn && pins.length === 0) {
		// Nothing sorts this account's new mail. Forget how far sorting had
		// got: whatever starts it again (a pin, the tabs, Jev, a key on the
		// server) starts from that moment, never from where this left off.
		if (settings.sortCursor) updateJevSettings(accountRowId, { sortCursor: null }, now);
		return;
	}
	if (jevOn && opts.fromStream && typesafeFailingFor(accountRowId)) return;
	// A scheduled pass tries TypeSafe again; if it still fails, it says so.
	if (!opts.fromStream) retryTypesafe(accountRowId);

	let cursor = settings.sortCursor;
	if (!jevOn) {
		// Pins only. Such a pass never reaches further back than the mail the
		// Inbox may still be holding for it (see inbox-hold), whatever cursor
		// is stored: one left from when Jev last read this account, or from
		// before the pins or the tabs were last switched off, can be days old.
		// Following it would leave the message that just arrived waiting behind
		// a backlog, past its hold, and move old mail around unasked. What was
		// queued back then is withdrawn for the same reason.
		const earliest = now.getTime() - INBOX_HOLD_MS;
		if (!cursor || !(Date.parse(cursor) >= earliest)) {
			cursor = new Date(earliest).toISOString();
			updateJevSettings(accountRowId, { sortCursor: cursor }, now);
			dropNewArrivals(accountRowId, now.getTime());
		}
	} else if (!cursor) {
		// Jev reads only what arrives from here on.
		updateJevSettings(accountRowId, { sortCursor: now.toISOString() }, now);
		return;
	}

	// With Jev off there is nothing to ask, about spam or anything else.
	const spamMode: SpamMode = jevOn ? settings.spamMode : 'off';
	// Telegram alerts for urgent mail: one more question for Jev, new mail only.
	const alertUrgent = jevOn && urgentAlertsWanted(accountRowId);
	if (!wantsTabs && spamMode === 'off' && !alertUrgent) {
		// Nothing to ask: keep the cursor current, so switching tabs on later
		// doesn't reach back into mail from before.
		advanceSortCursor(accountRowId, cursor, now.toISOString(), now);
		return;
	}

	// Rules are the rules scheduler's, and they go first, whatever this pass
	// is for. With tabs on, the Inbox holds new mail until Jev marks it (see
	// inbox-hold), so a rule's move or tab has to land before the mark, not
	// after the message is showing. With tabs off, a rule's move has to land
	// before a spam verdict could send the same message to Junk. Rules don't
	// wait on TypeSafe, so they keep working while it is down.
	if (listRules(accountRowId).some(isRunnable)) {
		try {
			await applyRulesNow(auth, accountEmail);
		} catch (err) {
			if (err instanceof JMAPAuthError) throw err;
			console.error('[jev] rules before sorting failed', accountEmail, err);
		}
	}

	const client = createClient(auth);
	const { accountId } = auth;
	const mailboxes = await getMailboxes(client, accountId);
	const inbox = mailboxes.find((m) => m.role === 'inbox');
	if (!inbox) return;
	// With spam checking on, Junk is watched too: Stalwart's verdicts there
	// are what Jev can confirm, or (in active mode) rescue mail from.
	const junk = spamMode !== 'off' ? (mailboxes.find((m) => m.role === 'junk') ?? null) : null;

	// 1. Queue what arrived since the cursor — in the Inbox, and in Junk
	// while spam checking is on.
	const watched = [inbox.id, ...(junk ? [junk.id] : [])];
	const arrivals = await client.request(
		watched.flatMap((mailboxId, i): MethodCall[] => [
			[
				'Email/query',
				{
					accountId,
					filter: { operator: 'AND', conditions: [{ inMailbox: mailboxId }, { after: cursor }] },
					sort: [{ property: 'receivedAt', isAscending: true }],
					limit: QUEUE_PAGE
				},
				`q${i}`
			],
			[
				'Email/get',
				{
					accountId,
					'#ids': { resultOf: `q${i}`, name: 'Email/query', path: '/ids' },
					properties: ['id', 'receivedAt']
				},
				`g${i}`
			]
		])
	);
	// A full page may have more behind it: resume from the earliest last-seen.
	const resumeAt: string[] = [];
	for (const [name, result] of arrivals.methodResponses) {
		if (name !== 'Email/get') continue;
		const arrived = (result as { list?: { id: string; receivedAt: string }[] }).list ?? [];
		enqueueEmails(accountRowId, arrived.map((e) => e.id), now.getTime());
		if (arrived.length >= QUEUE_PAGE) resumeAt.push(arrived[arrived.length - 1].receivedAt);
	}
	// Stalwart stamps receivedAt to the second and `after` is strict, so a
	// cursor at this pass's own instant would never again match mail landing
	// later in the same second. Re-read a short window instead: ids already
	// queued are ignored, and the window never reaches back past the cursor
	// it started from.
	// On a full page the cursor steps back a second for ties, unless the whole
	// page is that one second: then stepping back would never move it on.
	const lastSeen = resumeAt.sort()[0];
	const nextCursor = lastSeen
		? Date.parse(lastSeen) - 1000 > Date.parse(cursor)
			? new Date(Date.parse(lastSeen) - 1000).toISOString()
			: lastSeen
		: new Date(Math.max(Date.parse(cursor), now.getTime() - CURSOR_LOOKBACK_MS)).toISOString();
	advanceSortCursor(accountRowId, cursor, nextCursor, now);

	// TypeSafe rate-limited every call of a recent pass: it asked for a pause,
	// so the queue waits (what arrives meanwhile is queued above all the same).
	// A pinned sender's mail doesn't wait with it: its tab needs no answer.
	const paused = jevOn && rateLimitPaused(accountRowId, now.getTime());
	if (paused && pins.length === 0) return;

	// Fetched only once there is mail to judge (contacts need the session).
	let judgeCtx: JudgeContext | null = null;
	const batch: Batch = {
		client,
		accountId,
		accountRowId,
		inboxId: inbox.id,
		mailboxes,
		mailboxesRefreshed: false,
		junkId: junk?.id ?? null,
		spamMode,
		jev: !jevOn ? 'off' : paused ? 'wait' : 'ask',
		judge: async () =>
			(judgeCtx ??= {
				accountRowId,
				accountEmail,
				sentId: mailboxes.find((m) => m.role === 'sent')?.id ?? null,
				session: await fetchSession(auth).catch(() => null)
			}),
		// A pinned sender's tab is already decided: Jev isn't asked for it.
		pins,
		now,
		writes: noWrites()
	};

	// Jev can be switched off while a pass runs. Look again before each
	// batch, so nothing more is sent once it is. (A pass that asks Jev
	// nothing has nothing to stop.)
	const stillOn = () => !jevOn || getJevSettings(accountRowId).jevEnabled;

	// 2. New arrivals, and earlier failures among them: spam, urgency and tab.
	if (!stillOn()) return;
	await judgeAndApply(batch, listPendingEmailIds(accountRowId, JUDGE_BATCH), wantsTabs, spamMode !== 'off', alertUrgent);

	// 3. Then mail that was already in the Inbox when you asked Jev to sort
	// it: its tab only — spam checks and alerts apply to new mail only.
	if (batch.jev === 'ask' && wantsTabs && !opts.fromStream && stillOn()) {
		await runBackfill(batch);
	}
	noteWrites(accountRowId, batch.writes);
}

let started = false;
const inFlight = new Set<string>();
// A pass asked for while one was running: run once more when it ends, as
// the running one may have read the Inbox before the mail that asked.
const rerun = new Map<string, PassRequest>();

interface PassRequest {
	accountEmail: string;
	auth: AuthState;
	opts: PassOptions;
}

/**
 * One account's pass, never throwing. Passes don't overlap: one asked for
 * while another runs is run once, straight after it (as a full pass if any
 * of those asking wanted one).
 */
export async function sortNewMailSafe(
	accountRowId: string,
	accountEmail: string,
	auth: AuthState,
	opts: PassOptions = {}
): Promise<void> {
	if (inFlight.has(accountRowId)) {
		const queued = rerun.get(accountRowId);
		const fromStream = !!opts.fromStream && (queued ? !!queued.opts.fromStream : true);
		rerun.set(accountRowId, { accountEmail, auth, opts: { fromStream } });
		return;
	}
	inFlight.add(accountRowId);
	try {
		for (let next: PassRequest | undefined = { accountEmail, auth, opts }; next; ) {
			rerun.delete(accountRowId);
			try {
				await sortNewMail(accountRowId, next.accountEmail, next.auth, new Date(), next.opts);
				noteRecovered('pass', accountRowId, 'pass_recovered');
			} catch (err) {
				// A 401 is logged, and sent to Telegram, by markNeedsReauth.
				if (err instanceof JMAPAuthError) {
					markNeedsReauth(accountRowId);
					break;
				}
				console.error('[jev] sorting failed', next.accountEmail, err);
				noteFailure('pass', accountRowId, 'pass_failed', errorFields(err));
			}
			next = rerun.get(accountRowId);
		}
	} finally {
		rerun.delete(accountRowId);
		inFlight.delete(accountRowId);
	}
}

export function startJevScheduler(): void {
	if (started) return;
	started = true;
	// Judge new mail as it lands, not only on the minute.
	startJevWatchers(sortNewMailSafe);
	cron.schedule('* * * * *', async () => {
		for (const { account, auth } of listSchedulableAuths()) {
			await sortNewMailSafe(account.id, account.email, auth);
		}
	});
}
