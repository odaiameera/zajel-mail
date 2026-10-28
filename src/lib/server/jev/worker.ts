import cron from 'node-cron';
import { listSchedulableAuths, markNeedsReauth } from '$lib/server/auth/accounts';
import { JMAPAuthError, type JMAPClient } from '$lib/jmap/client';
import { createClient, fetchSession } from '$lib/jmap/auth';
import { getMailboxes } from '$lib/jmap/mailbox';
import type { AuthState, Email, JMAPSession, MethodCall } from '$lib/jmap/types';
import { categoryKeywordPatch, categoryOf, type InboxCategory } from '$lib/types/categories';
import { hasJevCondition, type Rule } from '$lib/types/rules';
import { getJevSettings, updateJevSettings, type SpamMode } from '$lib/server/db/queries/jev-settings';
import { getRules } from '$lib/server/db/queries/rules';
import { listPins, pinFor, senderHistory, type SenderPin } from '$lib/server/db/queries/jev-learning';
import {
	addUsage,
	enqueueEmails,
	getDecision,
	listPendingEmailIds,
	markSkipped,
	recordDecision,
	recordFailure,
	type JevRuleCheck
} from '$lib/server/db/queries/jev-decisions';
import {
	emptyOutcome,
	evaluateRulesForEmail,
	extractBodyText,
	jevConditionsToAsk,
	outcomeToUpdate,
	type RuleActionCtx,
	type RuleOutcome
} from '$lib/server/rules-engine';
import { askJev, jevMode } from './client';
import {
	CATEGORY_QUESTION,
	CATEGORY_QUESTION_ID,
	decideCategory,
	type CategoryDecision
} from './categorize';
import { buildEmailState, type JevFacts } from './email-state';
import { gatherFacts, senderAddress } from './facts';
import { conditionAnswers, ruleChecks, ruleQuestions } from './rules';
import { decideSpam, SPAM_QUESTIONS, spamAnswers, type SpamAction } from './spam';
import type { JevQuestion, JevResponse } from './types';

/**
 * Jev triaging new Inbox mail a beat after it lands — the same shape as the
 * rules scheduler: every minute, plus a catch-up for whoever is using the
 * app. Only accounts that let Jev read their mail are touched, and only mail
 * that arrived after that was switched on.
 *
 * Each email gets one Jev call holding everything there is to ask: the
 * Inbox tab (when tabs are on) and every rule condition written for Jev
 * that could still decide a rule. When the account has such rules, this
 * worker evaluates all of its rules — exact ones included — and the rules
 * scheduler steps aside (see `jevHandlesRules`), so rules keep their order
 * and Stop processing keeps working.
 *
 * Arrivals are queued in jev_decisions and judged from the queue: an email
 * whose call fails is retried on the next run, and after MAX_JEV_ATTEMPTS
 * its rules run with every Jev condition counted as not holding. The
 * cursor keeps moving for everything else.
 */

/** New arrivals queued per run. */
const QUEUE_PAGE = 100;
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

/** Fetch emails with everything the state, facts and rules are built from. */
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
			return {
				email,
				facts: emailFacts,
				response: null,
				decision: null,
				error: err instanceof Error ? err.message : String(err)
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
	update: Record<string, unknown>;
	/** The tab a pin or Jev's pick put it in (not a rule's), for the record. */
	tab: InboxCategory | null;
	/** The pin that chose the tab, if one did. */
	pin: SenderPin | null;
	checks: JevRuleCheck[];
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

/** Move an email from one mailbox to another, as a full mailboxIds write. */
function moveUpdate(email: Email, from: string, to: string): Record<string, unknown> {
	const outcome = emptyOutcome();
	outcome.removeMailboxIds.add(from);
	outcome.addMailboxIds.add(to);
	return outcomeToUpdate(email, outcome);
}

/** How a spam action reads in the record: what was done, or would have been. */
function spamActionLabel(action: SpamAction | null, mode: SpamMode): string | null {
	if (!action) return null;
	const done = { junk: 'junked', rescue: 'rescued', flag: 'flagged' }[action];
	return mode === 'active' ? done : `would_${action}`;
}

/**
 * What to do with one email: the rules' outcome — with Jev's answers for
 * their conditions — and then its tab. A rule that picks a tab wins, then
 * your pin for the sender, then Jev's own pick; none of them overrules a tab
 * the message already has.
 */
function planFor(
	judged: JudgedEmail,
	rules: Rule[],
	ruleCtx: RuleActionCtx,
	wantsTabs: boolean,
	pin: SenderPin | null
): Plan {
	const email = judged.email;
	const answers = conditionAnswers(judged.response);
	const outcome: RuleOutcome =
		rules.length > 0
			? evaluateRulesForEmail(email, rules, ruleCtx, extractBodyText(email), answers)
			: emptyOutcome();
	const open = wantsTabs && !outcome.category && categoryOf(email.keywords) === 'important';
	const pinned = open && pin ? pin : null;
	const tab = pinned ? pinned.category : open ? tabToApply(judged) : null;
	if (tab && tab !== 'important') Object.assign(outcome.keywords, categoryKeywordPatch(tab));
	return {
		update: outcomeToUpdate(email, outcome),
		tab,
		pin: pinned,
		checks: ruleChecks(rules, answers, outcome.firedRuleIds)
	};
}

/** Write updates in batches; returns the ids the server refused. */
async function writeUpdates(
	client: JMAPClient,
	accountId: string,
	updates: [string, Record<string, unknown>][]
): Promise<Set<string>> {
	const refused = new Set<string>();
	for (let i = 0; i < updates.length; i += WRITE_BATCH) {
		const chunk = updates.slice(i, i + WRITE_BATCH);
		try {
			const res = await client.request([
				['Email/set', { accountId, update: Object.fromEntries(chunk) }, '0']
			]);
			const result = res.methodResponses[0][1] as { notUpdated?: Record<string, unknown> | null };
			for (const id of Object.keys(result.notUpdated ?? {})) refused.add(id);
		} catch (err) {
			if (err instanceof JMAPAuthError) throw err;
			for (const [id] of chunk) refused.add(id);
		}
	}
	return refused;
}

/** One triage pass for one account: queue arrivals, judge, apply, record. */
export async function sortNewMail(
	accountRowId: string,
	accountEmail: string,
	auth: AuthState,
	now = new Date()
): Promise<void> {
	const settings = getJevSettings(accountRowId);
	if (!settings.jevEnabled || jevMode() === 'off') return;
	if (!settings.sortCursor) {
		updateJevSettings(accountRowId, { sortCursor: now.toISOString() }, now);
		return;
	}

	const enabledRules = getRules(accountEmail).filter((r) => r.enabled);
	const wantsTabs = settings.inboxTabs;
	// Only when a rule needs Jev does this worker take over the rules.
	const rules = enabledRules.some(hasJevCondition) ? enabledRules : [];
	const spamMode = settings.spamMode;
	if (!wantsTabs && rules.length === 0 && spamMode === 'off') {
		// Nothing to ask: keep the cursor current, so switching tabs or a Jev
		// rule on later doesn't reach back into mail from before.
		updateJevSettings(accountRowId, { sortCursor: now.toISOString() }, now);
		return;
	}

	const client = createClient(auth);
	const { accountId } = auth;
	const mailboxes = await getMailboxes(client, accountId);
	const inbox = mailboxes.find((m) => m.role === 'inbox');
	if (!inbox) return;
	// With spam checking on, Junk is watched too: Stalwart's verdicts there
	// are what Jev can confirm, or (in active mode) rescue mail from.
	const junk = spamMode !== 'off' ? (mailboxes.find((m) => m.role === 'junk') ?? null) : null;
	const ruleCtx: RuleActionCtx = {
		inboxId: inbox.id,
		trashId: mailboxes.find((m) => m.role === 'trash')?.id,
		validMailboxIds: new Set(mailboxes.map((m) => m.id))
	};

	// 1. Queue what arrived since the cursor — in the Inbox, and in Junk
	// while spam checking is on.
	const watched = [inbox.id, ...(junk ? [junk.id] : [])];
	const arrivals = await client.request(
		watched.flatMap((mailboxId, i): MethodCall[] => [
			[
				'Email/query',
				{
					accountId,
					filter: { operator: 'AND', conditions: [{ inMailbox: mailboxId }, { after: settings.sortCursor }] },
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
	const nextCursor = resumeAt.length ? resumeAt.sort()[0] : now.toISOString();
	updateJevSettings(accountRowId, { sortCursor: nextCursor }, now);

	// Fetched only once there is mail to judge (contacts need the session).
	let judgeCtx: JudgeContext | null = null;
	const batch: Batch = {
		client,
		accountId,
		accountRowId,
		inboxId: inbox.id,
		junkId: junk?.id ?? null,
		spamMode,
		judge: async () =>
			(judgeCtx ??= {
				accountRowId,
				accountEmail,
				sentId: mailboxes.find((m) => m.role === 'sent')?.id ?? null,
				session: await fetchSession(auth).catch(() => null),
				security: spamMode !== 'off'
			}),
		ruleCtx,
		// A pinned sender's tab is already decided: Jev isn't asked for it.
		pins: wantsTabs ? listPins(accountRowId) : [],
		now
	};

	// 2. New arrivals, and earlier failures among them: spam, tab and rules.
	await judgeAndApply(batch, listPendingEmailIds(accountRowId, JUDGE_BATCH), rules, wantsTabs, spamMode !== 'off');

	// 3. Then mail that was already in the Inbox when you asked Jev to sort
	// it: its tab only — rules and spam checks apply to new mail only.
	if (wantsTabs) {
		await judgeAndApply(batch, listPendingEmailIds(accountRowId, BACKFILL_BATCH, true), [], true, false);
	}
}

interface Batch {
	client: JMAPClient;
	accountId: string;
	accountRowId: string;
	inboxId: string;
	/** Watched while spam checking is on. */
	junkId: string | null;
	spamMode: SpamMode;
	judge: () => Promise<JudgeContext>;
	ruleCtx: RuleActionCtx;
	pins: SenderPin[];
	now: Date;
}

/** Judge queued emails, apply what follows, and record it. */
async function judgeAndApply(
	b: Batch,
	ids: string[],
	rules: Rule[],
	wantsTabs: boolean,
	checkSpam: boolean
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
	const judged = await judgeEmails(b.client, b.accountId, judgeable, await b.judge(), (email) =>
		// Junk mail is only checked for spam: no tab, no rules.
		inJunk(email)
			? SPAM_QUESTIONS
			: {
					...(checkSpam ? SPAM_QUESTIONS : {}),
					// No point asking for a tab the message already has: Jev won't overrule it.
					...(wantsTabs && !pinOf(email) && categoryOf(email.keywords) === 'important' ? tabQuestion() : {}),
					...ruleQuestions(jevConditionsToAsk(email, rules, extractBodyText(email)))
				}
	);

	// Plan each email. A failed call is retried next run; once it has failed
	// for good, the rules still run, with no Jev answers. Spam goes first:
	// mail that goes to Junk skips rules and tabs.
	const plans = new Map<string, Plan>();
	for (const j of judged) {
		if (j.error) {
			recordFailure(b.accountRowId, j.email.id, j.error, now);
			if (inJunk(j.email) || getDecision(b.accountRowId, j.email.id)?.status !== 'failed' || rules.length === 0) continue;
			plans.set(j.email.id, planFor({ ...j, decision: null }, rules, b.ruleCtx, false, null));
			continue;
		}
		const verdict = checkSpam ? spamAnswers(j.response?.answers) : null;
		const junked = inJunk(j.email);
		const action = verdict
			? decideSpam({
					...verdict,
					inJunk: junked,
					// Contacts and people you've written to are never sent to Junk.
					trusted: !!(j.facts?.sender_in_contacts || j.facts?.you_have_written_to_sender),
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
				update: rescue && b.junkId ? moveUpdate(j.email, b.junkId, b.inboxId) : {},
				tab: null,
				pin: null,
				checks: [],
				spam
			});
		} else if (acting && action === 'junk' && b.junkId) {
			plans.set(j.email.id, { update: moveUpdate(j.email, b.inboxId, b.junkId), tab: null, pin: null, checks: [], spam });
		} else {
			plans.set(j.email.id, { ...planFor(j, rules, b.ruleCtx, wantsTabs, pinOf(j.email)), spam });
		}
	}

	// Apply, worked out before anything changes.
	const updates = [...plans]
		.filter(([, p]) => Object.keys(p.update).length > 0)
		.map(([id, p]) => [id, p.update] as [string, Record<string, unknown>]);
	const refused = await writeUpdates(b.client, b.accountId, updates);

	// Record.
	for (const j of judged) {
		const plan = plans.get(j.email.id);
		if (!plan || j.error) continue; // failures were recorded above
		if (refused.has(j.email.id)) {
			recordFailure(b.accountRowId, j.email.id, 'The mail server refused the change', now);
			continue;
		}
		recordDecision(
			b.accountRowId,
			j.email.id,
			{
				category: plan.pin ? plan.pin.category : (j.decision?.category ?? null),
				confidence: plan.pin ? null : (j.decision?.confidence ?? null),
				applied: plan.tab,
				pinnedBy: plan.pin?.sender ?? null,
				answers: j.response?.answers ?? {},
				facts: j.facts ?? {},
				rules: plan.checks,
				model: j.response?.model ?? null,
				inputTokens: j.response?.usage.inputTokens ?? 0,
				spam: plan.spam ?? null
			},
			now
		);
	}
}

let started = false;
const inFlight = new Set<string>();

/** One account's pass, never throwing; overlapping passes are skipped. */
export async function sortNewMailSafe(
	accountRowId: string,
	accountEmail: string,
	auth: AuthState
): Promise<void> {
	if (inFlight.has(accountRowId)) return;
	inFlight.add(accountRowId);
	try {
		await sortNewMail(accountRowId, accountEmail, auth);
	} catch (err) {
		if (err instanceof JMAPAuthError) markNeedsReauth(accountRowId);
		else console.error('[jev] sorting failed', accountEmail, err);
	} finally {
		inFlight.delete(accountRowId);
	}
}

export function startJevScheduler(): void {
	if (started) return;
	started = true;
	cron.schedule('* * * * *', async () => {
		for (const { account, auth } of listSchedulableAuths()) {
			await sortNewMailSafe(account.id, account.email, auth);
		}
	});
}
