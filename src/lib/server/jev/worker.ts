import cron from 'node-cron';
import { listSchedulableAuths, markNeedsReauth } from '$lib/server/auth/accounts';
import { JMAPAuthError, type JMAPClient } from '$lib/jmap/client';
import { createClient, fetchSession } from '$lib/jmap/auth';
import { getMailboxes } from '$lib/jmap/mailbox';
import type { AuthState, Email, JMAPSession, Mailbox, MethodCall } from '$lib/jmap/types';
import { categoryKeywordPatch, categoryOf, type InboxCategory } from '$lib/types/categories';
import { isRunnable } from '$lib/types/rules';
import {
	advanceSortCursor,
	getJevSettings,
	updateJevSettings,
	type SpamMode
} from '$lib/server/db/queries/jev-settings';
import { listRules } from '$lib/server/rules/store';
import { listPins, pinFor, senderHistory, type SenderPin } from '$lib/server/db/queries/jev-learning';
import {
	addUsage,
	correctedEmailIds,
	dropNewArrivals,
	enqueueEmails,
	listPendingEmailIds,
	markSkipped,
	recordDecision,
	recordFailure
} from '$lib/server/db/queries/jev-decisions';
import { emptyOutcome, outcomeToUpdate, type RuleOutcome } from '$lib/server/rules/engine';
import { askJev, JevError, jevMode } from './client';
import {
	CATEGORY_QUESTION,
	CATEGORY_QUESTION_ID,
	decideCategory,
	type CategoryDecision
} from './categorize';
import { buildEmailState, type JevFacts } from './email-state';
import { gatherFacts, senderAddress } from './facts';
import { decideSpam, SPAM_QUESTIONS, spamAnswers, type SpamAction } from './spam';
import { isUrgent, URGENT_QUESTION, URGENT_QUESTION_ID } from '$lib/server/telegram/urgent';
import { flushAlerts, queueUrgent, urgentAlertsWanted } from '$lib/server/telegram/notifier';
import { errorFields, logEvent } from '$lib/server/log';
import { INBOX_HOLD_MS, isHeld, JEV_SORTED_KEYWORD } from '$lib/inbox-hold';
import { hasUnknownMailbox } from '$lib/mailboxes';
import type { JevQuestion, JevResponse } from './types';
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
/** Queued existing emails judged per run, after the new ones. */
const BACKFILL_BATCH = 100;
/** Parallel calls to TypeSafe per account. */
const CONCURRENCY = 4;
/** Updates per Email/set. */
const WRITE_BATCH = 50;
/** How many of the newest Inbox emails "Try Jev" judges. */
export const PREVIEW_LIMIT = 200;
/** Body bytes fetched per email — comfortably more than the excerpt needs. */
const MAX_BODY_BYTES = 16_000;
/** How long an account's queue waits after TypeSafe rate-limited every call of a pass. */
const RATE_LIMIT_PAUSE_MS = 5 * 60_000;

const JEV_EMAIL_PROPERTIES = [
	'id', 'threadId', 'mailboxIds', 'keywords',
	'from', 'to', 'cc', 'subject', 'receivedAt', 'preview',
	'size', 'hasAttachment',
	'textBody', 'htmlBody', 'bodyValues',
	// Raw form: Stalwart 1.0 rejects `:asText` for this RFC 2369 header.
	'header:list-unsubscribe',
	'header:list-id:asText',
	'header:precedence:asText',
	'header:auto-submitted:asText',
	// Spam evidence, used while spam checking is on.
	'replyTo',
	'header:authentication-results:asText:all',
	'header:x-spam-status:asText',
	'header:x-spam-score:asText',
	'header:x-spam-result:asText'
];

/** Fetch emails with everything the state and facts are built from. */
export async function fetchEmailsForJev(
	client: JMAPClient,
	accountId: string,
	ids: string[]
): Promise<Email[]> {
	if (ids.length === 0) return [];
	const response = await client.request([
		[
			'Email/get',
			{
				accountId,
				ids,
				properties: JEV_EMAIL_PROPERTIES,
				fetchTextBodyValues: true,
				fetchHTMLBodyValues: true,
				maxBodyValueBytes: MAX_BODY_BYTES
			},
			'g'
		]
	]);
	return (response.methodResponses[0][1] as { list?: Email[] }).list ?? [];
}

/** Run `fn` over `items`, at most `limit` at a time, keeping order. */
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const out: R[] = new Array(items.length);
	let next = 0;
	async function lane() {
		while (next < items.length) {
			const i = next++;
			out[i] = await fn(items[i]);
		}
	}
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
	return out;
}

export interface JudgedEmail {
	email: Email;
	/** Null when there was nothing to ask, so Jev wasn't called. */
	facts: JevFacts | null;
	response: JevResponse | null;
	/** The tab decision, when the tab was asked about. */
	decision: CategoryDecision | null;
	error: string | null;
	/** TypeSafe's status for a failed call: 429 means it is busy, not that the email is bad. */
	errorStatus?: number;
	/** TypeSafe refused this very request: a 4xx that is not about the key, the model or its load. */
	refused?: boolean;
}

export interface JudgeContext {
	/** The linked account row — usage is counted against it. */
	accountRowId: string;
	accountEmail: string;
	sentId: string | null;
	session: JMAPSession | null;
	/** Send origin evidence and Stalwart's verdict (spam checking on). */
	security?: boolean;
}

/** The judge context for an account, with your sender history attached. */
function withHistory(ctx: JudgeContext) {
	return { ...ctx, senderHistory: (sender: string) => senderHistory(ctx.accountRowId, sender) };
}

const tabQuestion = (): Record<string, JevQuestion> => ({ [CATEGORY_QUESTION_ID]: CATEGORY_QUESTION });

/**
 * Ask Jev each email's questions — by default just the Inbox tab. Emails
 * with nothing to ask aren't sent. Shared by the worker and the previews;
 * a failed call becomes `error` on that email, never a throw.
 */
export async function judgeEmails(
	client: JMAPClient,
	accountId: string,
	emails: Email[],
	ctx: JudgeContext,
	questionsFor: (email: Email) => Record<string, JevQuestion> = tabQuestion
): Promise<JudgedEmail[]> {
	const questions = new Map(emails.map((e) => [e.id, questionsFor(e)]));
	const asking = emails.filter((e) => Object.keys(questions.get(e.id)!).length > 0);
	const facts = await gatherFacts(client, accountId, asking, withHistory(ctx));
	return mapPool(emails, CONCURRENCY, async (email): Promise<JudgedEmail> => {
		const emailQuestions = questions.get(email.id)!;
		const emailFacts = facts.get(email.id) ?? null;
		if (!emailFacts) return { email, facts: null, response: null, decision: null, error: null };
		try {
			const response = await askJev(buildEmailState(email, emailFacts), emailQuestions);
			if (!response.mock) addUsage(ctx.accountRowId, response.usage.inputTokens);
			return {
				email,
				facts: emailFacts,
				response,
				decision: emailQuestions[CATEGORY_QUESTION_ID]
					? decideCategory(response.answers[CATEGORY_QUESTION_ID])
					: null,
				error: null
			};
		} catch (err) {
			const upstream = err instanceof JevError ? err.upstream : null;
			return {
				email,
				facts: emailFacts,
				response: null,
				decision: null,
				error: err instanceof Error ? err.message : String(err),
				errorStatus: err instanceof JevError ? err.status : undefined,
				refused: upstream !== null && upstream >= 400 && upstream < 500 && ![401, 403, 404, 429].includes(upstream)
			};
		}
	});
}

/**
 * The tab Jev's own pick puts a judged email in, or null to leave it. Jev
 * never overrules a tab the message already has — you, or a rule, moved it
 * there first — and only a confident pick is used.
 */
export function tabToApply(judged: JudgedEmail): InboxCategory | null {
	if (!judged.decision?.apply) return null;
	if (categoryOf(judged.email.keywords) !== 'important') return null;
	return judged.decision.apply;
}

interface Plan {
	/** What to do to the message — applied to where it is when it is written. */
	outcome: RuleOutcome;
	/** The tab a pin or Jev's pick put it in, for the record. */
	tab: InboxCategory | null;
	/** The pin that chose the tab, if one did. */
	pin: SenderPin | null;
	/** Jev's spam answers and what came of them, when spam checking is on. */
	spam?: SpamRecord | null;
}

interface SpamRecord {
	spam: number;
	phishing: number;
	stalwartSpam: boolean;
	/** 'junked' | 'rescued' | 'flagged', or in watch mode 'would_…'. */
	action: string | null;
}

/**
 * Move a message to Junk or back to the Inbox. It is a move like any other
 * (see `nextMailboxIds`): the message keeps its labels and leaves every
 * other folder.
 */
function moveOutcome(to: string): RuleOutcome {
	const outcome = emptyOutcome();
	outcome.moveTo = to;
	return outcome;
}

const hasWork = (o: RuleOutcome) => o.moveTo !== null || o.labels.size > 0 || Object.keys(o.keywords).length > 0;

type Placement = Pick<Email, 'mailboxIds' | 'keywords'>;

/** Where each message is, and which tab it has, right now; one the server no longer has is absent. */
async function currentPlacement(client: JMAPClient, accountId: string, ids: string[]): Promise<Map<string, Placement>> {
	if (ids.length === 0) return new Map();
	const response = await client.request([
		['Email/get', { accountId, ids, properties: ['id', 'mailboxIds', 'keywords'] }, 'p']
	]);
	const list = (response.methodResponses[0][1] as { list?: (Placement & { id: string })[] }).list ?? [];
	return new Map(list.map((e) => [e.id, { mailboxIds: e.mailboxIds ?? {}, keywords: e.keywords ?? {} }]));
}

/**
 * Whether the sender is someone you know — a contact, or someone you've
 * written to — or null when a lookup couldn't tell. Unknown is not "no":
 * nothing moves to Junk on it (see decideSpam).
 */
function trustOf(facts: JevFacts | null): boolean | null {
	const looked = [facts?.sender_in_contacts, facts?.you_have_written_to_sender];
	if (looked.includes(true)) return true;
	return looked.every((v) => v === false) ? false : null;
}

/** How a spam action reads in the record: what was done, or would have been. */
function spamActionLabel(action: SpamAction | null, mode: SpamMode): string | null {
	if (!action) return null;
	const done = { junk: 'junked', rescue: 'rescued', flag: 'flagged' }[action];
	return mode === 'active' ? done : `would_${action}`;
}

/**
 * The tab for one email still in Important: your pin for the sender wins,
 * then Jev's own pick. Neither overrules a tab the message already has.
 * `wantsTabs` is false for mail you put in a tab yourself.
 *
 * A message already sitting in its pin's tab was put there by the pin, on
 * an earlier pass that couldn't reach Jev for the rest: the pin is still
 * what decided it, and the record says so.
 */
function planFor(judged: JudgedEmail, wantsTabs: boolean, pin: SenderPin | null): Plan {
	const outcome = emptyOutcome();
	const current = categoryOf(judged.email.keywords);
	const open = wantsTabs && current === 'important';
	const pinned = pin && wantsTabs && (open || current === pin.category) ? pin : null;
	const tab = pinned ? pinned.category : open ? tabToApply(judged) : null;
	if (tab && tab !== 'important') Object.assign(outcome.keywords, categoryKeywordPatch(tab));
	return { outcome, tab, pin: pinned };
}

/**
 * A SetError as one short line: its type, what the server said, and which
 * properties. It is the server's text, of whatever shape, so nothing about
 * it is trusted, and it is cut to the length errorFields keeps.
 */
function refusalText(err: unknown): string {
	const e = (err && typeof err === 'object' ? err : {}) as Record<string, unknown>;
	const what = [e.type, e.description].filter((v) => v != null && v !== '').map(String).join(': ') || 'no reason given';
	const props = Array.isArray(e.properties) ? ` (${e.properties.map(String).join(', ')})` : '';
	return `${what}${props}`.slice(0, 300);
}

/** What a pass's writes came to, for its one log line. */
interface WriteOutcome {
	attempted: number;
	refused: number;
	/** The first refusal's reason. */
	refusal: string | null;
	/** The first write that got no answer from the server. */
	unreachable: unknown;
}

/**
 * Write updates in batches; returns what to record for each message not
 * updated. A refused tab or label never reaches the message, and "refused"
 * alone can't tell a patch the server can't read from a message that's
 * gone, so the server's reason is kept. A write that got no answer is not a
 * refusal (after a timeout it may even have landed), and is recorded as such.
 */
async function writeUpdates(
	client: JMAPClient,
	accountId: string,
	updates: [string, Record<string, unknown>][],
	outcome: WriteOutcome
): Promise<Map<string, string>> {
	const failed = new Map<string, string>();
	outcome.attempted += updates.length;
	for (let i = 0; i < updates.length; i += WRITE_BATCH) {
		const chunk = updates.slice(i, i + WRITE_BATCH);
		let notUpdated: unknown;
		try {
			const res = await client.request([
				['Email/set', { accountId, update: Object.fromEntries(chunk) }, '0']
			]);
			notUpdated = (res.methodResponses[0][1] as { notUpdated?: unknown }).notUpdated;
		} catch (err) {
			if (err instanceof JMAPAuthError) throw err;
			outcome.unreachable ??= err;
			const reason = `Couldn’t reach the mail server: ${errorFields(err).error}`;
			for (const [id] of chunk) failed.set(id, reason);
			continue;
		}
		if (!notUpdated || typeof notUpdated !== 'object') continue;
		for (const [id, err] of Object.entries(notUpdated)) {
			const reason = refusalText(err);
			outcome.refused++;
			outcome.refusal ??= reason;
			failed.set(id, `The mail server refused the change: ${reason}`);
		}
	}
	return failed;
}

/**
 * Log a pass's writes once, after all its batches: a pass that keeps
 * refusing new mail while sorting existing mail fine is still failing, not
 * recovering, and logging per batch said both every minute.
 */
function noteWrites(accountRowId: string, w: WriteOutcome): void {
	if (w.unreachable) noteFailure('write', accountRowId, 'write_failed', errorFields(w.unreachable));
	else if (w.refusal) noteFailure('write', accountRowId, 'write_refused', { count: w.refused, error: w.refusal });
	else if (w.attempted) noteRecovered('write', accountRowId, 'write_recovered');
}

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
	if (jevOn && opts.fromStream && typesafeFailing.has(accountRowId)) return;
	// A scheduled pass tries TypeSafe again; if it still fails, it says so.
	if (!opts.fromStream) typesafeFailing.delete(accountRowId);

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
	const paused = jevOn && (rateLimitedUntil.get(accountRowId) ?? 0) > now.getTime();
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
		writes: { attempted: 0, refused: 0, refusal: null, unreachable: null }
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
		await judgeAndApply(batch, listPendingEmailIds(accountRowId, BACKFILL_BATCH, true), true, false, false);
	}
	noteWrites(accountRowId, batch.writes);
}

interface Batch {
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

/** Judge queued emails, apply what follows, and record it. */
async function judgeAndApply(
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
	const tabOpen = (email: Email) => wantsTabs && !chosen.has(email.id) && categoryOf(email.keywords) === 'important';
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
								// No point asking for a tab the message already has: Jev won't overrule it.
								...(tabOpen(email) && !pinOf(email) ? tabQuestion() : {})
							}
				)
			: judgeable.map((email) => ({ email, facts: null, response: null, decision: null, error: null }));

	const asked = judged.filter((j) => j.facts);
	// TypeSafe failed this whole pass, so no email is charged for it.
	let outage = false;
	if (asked.length && asked.every((j) => j.errorStatus === 429)) {
		// TypeSafe rate-limited every call: it asked for a pause, so this
		// account's queue waits a few minutes instead of knocking again every pass.
		rateLimitedUntil.set(b.accountRowId, now + RATE_LIMIT_PAUSE_MS);
		typesafeFailing.add(b.accountRowId);
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
		typesafeFailing.add(b.accountRowId);
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
			const pin = !inJunk(j.email) && tabOpen(j.email) ? pinOf(j.email) : null;
			if (pin) plans.set(j.email.id, planFor({ ...j, decision: null }, true, pin));
			continue;
		}
		const verdict = checkSpam ? spamAnswers(j.response?.answers) : null;
		const junked = inJunk(j.email);
		const action = verdict
			? decideSpam({
					...verdict,
					inJunk: junked,
					// Contacts and people you've written to are never sent to Junk —
					// nor is anyone while that couldn't be checked.
					trusted: trustOf(j.facts),
					// Out of Junk needs a DMARC pass, not just "no fail".
					dmarcPassed: j.facts?.security?.dmarc === 'pass'
				})
			: null;
		const spam: SpamRecord | null = verdict
			? {
					...verdict,
					stalwartSpam: junked || !!j.facts?.security?.stalwart_flagged,
					action: spamActionLabel(action, b.spamMode)
				}
			: null;
		const acting = b.spamMode === 'active';
		if (junked) {
			const rescue = acting && action === 'rescue';
			plans.set(j.email.id, {
				outcome: rescue && b.junkId ? moveOutcome(b.inboxId) : emptyOutcome(),
				tab: null,
				pin: null,
				spam
			});
		} else if (acting && action === 'junk' && b.junkId) {
			toJunk.add(j.email.id);
			plans.set(j.email.id, { outcome: moveOutcome(b.junkId), tab: null, pin: null, spam });
		} else {
			plans.set(j.email.id, { ...planFor(j, wantsTabs && !chosen.has(j.email.id), pinOf(j.email)), spam });
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

	// Record.
	for (const j of judged) {
		const plan = plans.get(j.email.id);
		// Failures were recorded above; mail Jev hasn't answered for stays queued.
		if (!plan || j.error || b.jev === 'wait') continue;
		const writeError = notWritten.get(j.email.id);
		if (writeError !== undefined) {
			recordFailure(b.accountRowId, j.email.id, writeError, now);
			continue;
		}
		// With Jev off, a pin's doing is the only decision there is to record.
		// The rest was let through as it came: it counts as never sorted, so
		// "sort the mail already in your Inbox" offers it if Jev is switched on.
		if (b.jev === 'off' && !plan.pin) {
			markSkipped(b.accountRowId, j.email.id, now);
			continue;
		}
		const applied = !moved.has(j.email.id);
		recordDecision(
			b.accountRowId,
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

	// Urgent Inbox mail goes to the linked Telegram chat; never Junk, or mail
	// on its way there.
	// Every alert is queued before any is sent: the emails are already marked
	// done, so one not queued before a crash would never be alerted.
	if (alertUrgent && b.jev === 'ask') {
		const flushFor = new Set<string>();
		for (const j of judged) {
			if (j.error || inJunk(j.email) || toJunk.has(j.email.id) || !isUrgent(j.response)) continue;
			try {
				const userId = queueUrgent(b.accountRowId, j.email);
				if (userId) flushFor.add(userId);
			} catch (err) {
				console.error('[jev] urgent alert failed', err instanceof Error ? err.message : err);
				logEvent('error', 'jev', 'urgent_alert_failed', { account: b.accountRowId, ...errorFields(err) });
			}
		}
		for (const userId of flushFor) {
			await flushAlerts(userId).catch((err) => logEvent('error', 'jev', 'urgent_alert_failed', { account: b.accountRowId, ...errorFields(err) }));
		}
	}
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

// Accounts TypeSafe rate-limited on a recent pass, and until when they wait.
const rateLimitedUntil = new Map<string, number>();

// Accounts whose last pass found TypeSafe down or rate-limiting: until a
// scheduled pass gets through, a change to their mail doesn't call again.
const typesafeFailing = new Set<string>();

/** Forget the rate-limit pauses and the failures logged — for tests, which run many passes on one account. */
export function forgetRateLimits(): void {
	rateLimitedUntil.clear();
	typesafeFailing.clear();
	lastFailure.clear();
}

// The failure last logged, per kind and account: a failing pass is logged
// when it starts failing or fails differently, and once when it recovers,
// not every minute in between.
const lastFailure = new Map<string, string>();

function noteFailure(kind: string, accountRowId: string, event: string, fields: Record<string, unknown>): void {
	const key = `${kind}:${accountRowId}`;
	const text = `${event}:${String(fields.error)}`;
	if (lastFailure.get(key) === text) return;
	lastFailure.set(key, text);
	logEvent('error', 'jev', event, { account: accountRowId, ...fields });
}

function noteRecovered(kind: string, accountRowId: string, event: string): void {
	if (lastFailure.delete(`${kind}:${accountRowId}`)) logEvent('info', 'jev', event, { account: accountRowId });
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
