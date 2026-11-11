import { JMAPMethodError, type JMAPClient } from '$lib/jmap/client';
import { getIdentities } from '$lib/jmap/identities';
import type { Email, EmailAddress, Mailbox } from '$lib/jmap/types';
import { getAccount, listAccounts } from './auth/accounts';
import { accountIdForEmail } from './db/queries/account-tasks';
import { getPrefs } from './db/queries/app-prefs';
import {
	claimAutoReply,
	pruneAutoReplyLog,
	removeAutoReplyLog,
	repliesSentSince,
	sendersAnsweredSince
} from './db/queries/auto-reply-log';
import { listIdentities } from './db/queries/identities';
import { headerFacts } from './jev/facts';
import { parseAuthResults } from './jev/spam';
import { errorFields, logEvent } from './log';
import { normalizeAddress } from './trust-sender';

/**
 * Out-of-office, sent by the app.
 *
 * The mail server never sent the Sieve vacation message this used to be,
 * so Zajel answers new Inbox mail itself, from the rules scheduler's run
 * (see runApply in rules-scheduler.ts), which sees each new message once.
 * One setting per login covers every linked mail account. Replies go out
 * only while Zajel is running.
 *
 * Sending mail nobody asked for is the risk here, so whether to answer is
 * one pure function, `shouldAutoReply`, that says no to anything automatic,
 * bulk, old, from the owner, not addressed to the account, or already
 * answered; and every reply is logged before it is sent. A reply only ever
 * goes to the message's From address, and at most once a day per person
 * across all of the login's accounts.
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/** Automatic replies one login may send in an hour, in case two responders get into a loop. */
export const HOURLY_CAP = 30;
const KEEP_LOG_DAYS = 30;

/**
 * Local parts that are never a person, beside the no-reply pattern Jev's
 * facts already use (`sender_looks_automated`), which doesn't know these.
 */
const ROBOTS = /^(?:mailer-daemon|postmaster)(?:[-+_.].*)?$/i;

/** What a reply decision reads off each new message, beside what rules read. */
export const AUTO_REPLY_PROPERTIES = [
	'from',
	'to',
	'cc',
	'replyTo',
	'messageId',
	'references',
	'subject',
	'receivedAt',
	'keywords',
	'header:auto-submitted:asText',
	'header:precedence:asText',
	'header:list-id:asText',
	'header:list-unsubscribe',
	'header:x-auto-response-suppress:asText',
	'header:x-spam-status:asText',
	'header:authentication-results:asText:all',
	'header:return-path:asText',
	'header:content-type:asText',
	'header:from:asGroupedAddresses'
];

export interface AutoReplySettings {
	enabled: boolean;
	subject: string;
	body: string;
	/** First day, `YYYY-MM-DD`, or '' for no start date. */
	from: string;
	/** Last day, `YYYY-MM-DD`, or '' for no end date. */
	until: string;
	/** The owner's time zone, so the dates are the owner's days. */
	tz: string;
	/** ISO time it was last switched on or its dates changed; nothing older is answered. */
	since: string;
}

function validTimeZone(tz: string): string {
	try {
		new Intl.DateTimeFormat('en', { timeZone: tz });
		return tz;
	} catch {
		return 'UTC';
	}
}

/** The out-of-office settings among a login's preferences. */
export function autoReplySettings(prefs: Record<string, string>): AutoReplySettings {
	return {
		enabled: prefs.auto_reply_enabled === 'on',
		subject: prefs.auto_reply_subject ?? '',
		body: prefs.auto_reply_body ?? '',
		from: prefs.auto_reply_from ?? '',
		until: prefs.auto_reply_until ?? '',
		tz: validTimeZone(prefs.auto_reply_tz || 'UTC'),
		since: prefs.auto_reply_since ?? ''
	};
}

/** The calendar day of `at` in `tz`, as `YYYY-MM-DD`. */
export function dayIn(tz: string, at: Date): string {
	const parts = new Intl.DateTimeFormat('en', {
		timeZone: validTimeZone(tz),
		year: 'numeric',
		month: '2-digit',
		day: '2-digit'
	}).formatToParts(at);
	const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
	return `${part('year')}-${part('month')}-${part('day')}`;
}

/**
 * Whether out-of-office is on at `at`: switched on, with a message, and
 * that day (in the owner's time zone) within the dates where they are set.
 * Settings switched on before this version have no `since` and are off:
 * nothing is answered until the owner saves them again.
 */
export function autoReplyActiveAt(s: AutoReplySettings, at: Date): boolean {
	if (!s.enabled || !s.body.trim() || !s.since) return false;
	const day = dayIn(s.tz, at);
	if (s.from && day < s.from) return false;
	if (s.until && day > s.until) return false;
	return true;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const shortDate = (day: string) => `${Number(day.slice(8, 10))} ${MONTHS[Number(day.slice(5, 7)) - 1]}`;

/** The settings page's status line: "Off", "On", "Starts 20 Nov", "On until 28 Nov", "Ended 28 Nov". */
export function autoReplyStatus(s: AutoReplySettings, now: Date): string {
	if (!s.enabled || !s.body.trim() || !s.since) return 'Off';
	const today = dayIn(s.tz, now);
	if (s.from && today < s.from) return `Starts ${shortDate(s.from)}`;
	if (s.until && today > s.until) return `Ended ${shortDate(s.until)}`;
	if (s.until) return `On until ${shortDate(s.until)}`;
	return 'On';
}

const isDay = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && new Date(`${d}T00:00:00Z`).toISOString().startsWith(d);

export type AutoReplyForm = Omit<AutoReplySettings, 'since'>;

/** The settings page's form, checked. */
export function parseAutoReplyForm(input: Record<string, unknown>): { form: AutoReplyForm } | { error: string } {
	const text = (v: unknown) => (typeof v === 'string' ? v : '');
	const form: AutoReplyForm = {
		enabled: input.enabled === true,
		subject: text(input.subject).trim(),
		body: text(input.body),
		from: text(input.from).trim(),
		until: text(input.until).trim(),
		tz: validTimeZone(text(input.tz) || 'UTC')
	};
	if (form.from && !isDay(form.from)) return { error: 'The start date isn’t a date.' };
	if (form.until && !isDay(form.until)) return { error: 'The end date isn’t a date.' };
	if (form.from && form.until && form.until < form.from) return { error: 'The end date is before the start date.' };
	if (form.enabled && !form.body.trim()) return { error: 'Write the message to send.' };
	return { form };
}

/**
 * The new `since` for a save: now when out-of-office is switched on or its
 * dates change, so mail from before that is never answered; unchanged
 * otherwise, so editing the message doesn't reset it.
 */
export function nextSince(prev: AutoReplySettings, next: AutoReplyForm, nowIso: string): string {
	if (!next.enabled) return '';
	if (prev.enabled && prev.since && prev.from === next.from && prev.until === next.until) return prev.since;
	return nowIso;
}

export interface ReplyContext {
	settings: AutoReplySettings;
	now: Date;
	/** The account's own address, for reading the headers. */
	accountEmail: string;
	/** The account's address and its identities, normalised: mail must be to one of them. */
	accountAddresses: Set<string>;
	/** Every address of the owner's: each linked account and its identities. */
	ownAddresses: Set<string>;
	/** Senders the login answered in the last 24 hours, from any of its accounts. */
	answered: Set<string>;
	/** Replies the login sent in the last hour, from any of its accounts. */
	sentLastHour: number;
}

export type ReplyDecision = { to: EmailAddress; sender: string } | { skip: string };

function isRobot(address: string): boolean {
	return ROBOTS.test(address.split('@')[0] ?? '');
}

/** A delivery report or read receipt: a null Return-Path, or a `multipart/report` body. */
function isDeliveryReport(email: Email): boolean {
	const returnPath = email['header:return-path:asText'];
	if (returnPath != null && /^\s*(?:<\s*>)?\s*$/.test(returnPath)) return true;
	return /^\s*multipart\/report\b/i.test(email['header:content-type:asText'] ?? '');
}

/** Outlook's X-Auto-Response-Suppress, when it asks for no out-of-office reply. */
function suppressesReplies(value: string | null | undefined): boolean {
	return (value ?? '')
		.split(',')
		.map((t) => t.trim().toLowerCase())
		.some((t) => t === 'all' || t === 'oof' || t === 'autoreply');
}

/**
 * Whether to answer `email`. The answer always goes to its From address,
 * never its Reply-To: anyone can set Reply-To, so it would let a stranger
 * aim the reply at a third party, or at a whole list, and step round the
 * once-a-day limit by changing From each time. Pure: everything it needs
 * is in `ctx`.
 */
export function shouldAutoReply(email: Email, ctx: ReplyContext): ReplyDecision {
	const s = ctx.settings;
	// 1. Only while it is on, only for mail since it was switched on, and
	// never for mail from more than a day ago (a restart after downtime).
	if (!autoReplyActiveAt(s, ctx.now)) return { skip: 'out-of-office is not on' };
	const received = Date.parse(email.receivedAt);
	if (!(received >= Date.parse(s.since))) return { skip: 'arrived before out-of-office was switched on' };
	if (ctx.now.getTime() - received > DAY) return { skip: 'arrived more than a day ago' };
	if (!autoReplyActiveAt(s, new Date(received))) return { skip: 'arrived outside the out-of-office dates' };

	// 2. Never to automatic or bulk mail.
	const facts = headerFacts(email, ctx.accountEmail);
	if (facts.auto_submitted) return { skip: 'automatic mail' };
	if (facts.bulk_precedence) return { skip: 'bulk mail' };
	if (facts.list_id || facts.has_list_unsubscribe) return { skip: 'mailing list' };
	if (suppressesReplies(email['header:x-auto-response-suppress:asText'])) return { skip: 'asks for no automatic reply' };
	if (isDeliveryReport(email)) return { skip: 'delivery report or read receipt' };

	// 3. Only to one real sender: From must be exactly one address, not a
	// group, not a robot, and not one that failed the server's sender
	// authentication (DMARC), since a forged From would aim the reply at
	// whoever was forged. Mail with no Authentication-Results is judged on
	// the rest, as before.
	const from = email.from ?? [];
	const grouped = email['header:from:asGroupedAddresses'];
	if (from.length !== 1 || grouped?.some((g) => g.name !== null)) return { skip: 'not one sender address' };
	const sender = normalizeAddress(from[0].email ?? '');
	if (!sender.includes('@')) return { skip: 'no sender address' };
	if (facts.sender_looks_automated || isRobot(sender)) return { skip: 'sender is not a person' };
	if (parseAuthResults(email['header:authentication-results:asText:all']).dmarc === 'fail') {
		return { skip: 'sender failed authentication' };
	}

	// 4. Never to the owner.
	if (ctx.ownAddresses.has(sender)) return { skip: 'from one of your own addresses' };

	// 5. Only to mail sent to the account itself, not via a list or Bcc.
	const recipients = [...(email.to ?? []), ...(email.cc ?? [])];
	if (!recipients.some((a) => ctx.accountAddresses.has(normalizeAddress(a.email ?? '')))) {
		return { skip: 'not addressed to this account' };
	}

	// 6. Never to spam.
	if (email.keywords?.$junk || /^\s*yes\b/i.test(email['header:x-spam-status:asText'] ?? '')) return { skip: 'spam' };

	// 7. One reply per sender per day.
	if (ctx.answered.has(sender)) return { skip: 'already answered today' };

	// 8. The hourly cap.
	if (ctx.sentLastHour >= HOURLY_CAP) return { skip: 'hourly limit reached' };

	return { to: { name: from[0].name ?? null, email: from[0].email.trim() }, sender };
}

export interface ReplyIdentity {
	id: string;
	email: string;
	name: string | null;
}

/** How a send ended: sent, surely not sent, maybe sent, or skipped (answered today, or the hourly cap, by another run). */
export type SendOutcome = 'sent' | 'refused' | 'uncertain' | 'skipped';

type SetResult = {
	created?: Record<string, { id?: string }> | null;
	notCreated?: Record<string, { type?: string; description?: string }> | null;
};

/** A JMAP `/set` response, or undefined when the server didn't answer that method. */
function setResult(response: { methodResponses: [string, unknown, string][] }, method: string): SetResult | undefined {
	return response.methodResponses.find(([name]) => name === method)?.[1] as SetResult | undefined;
}

const reasonOf = (err: { type?: string; description?: string } | undefined, fallback: string) =>
	err?.description ?? err?.type ?? fallback;

/**
 * Send one reply. The log row is written first, so a crash between sending
 * and recording can't lead to a second reply, and it is written only if
 * the login hasn't answered this sender today (checked again here, in the
 * same transaction, in case another account's run just did).
 *
 * The copy is created in one request and submitted in a second, so its id
 * is known whatever happens to the submission. The log row is removed only
 * when the server definitely refused (notCreated, or a method-level error):
 * a timeout or a dropped connection may come after the server sent the
 * mail, so then the row stays and the sender gets no more replies today.
 * When the submission didn't surely succeed, the copy is destroyed (it is
 * destroyed with the submission when that succeeds), so Drafts doesn't
 * fill up with unsent replies.
 */
export async function sendAutoReply(
	client: JMAPClient,
	email: Email,
	opts: {
		accountId: string;
		/** The mail account's row, for the log. */
		logAccountId: string;
		/** The login the account belongs to: the once-a-day check and the hourly cap are the login's. */
		userId: string;
		to: EmailAddress;
		sender: string;
		settings: AutoReplySettings;
		identity: ReplyIdentity;
		/** Where the copy sits until it is submitted. */
		mailboxId: string;
		now: Date;
	}
): Promise<SendOutcome> {
	const { accountId, identity } = opts;
	const fields = { account: opts.logAccountId, email_id: email.id };
	const logId = claimAutoReply({
		accountId: opts.logAccountId,
		userId: opts.userId,
		sender: opts.sender,
		sentAt: opts.now.toISOString(),
		emailId: email.id,
		answeredAfter: new Date(opts.now.getTime() - DAY).toISOString(),
		countAfter: new Date(opts.now.getTime() - HOUR).toISOString(),
		cap: HOURLY_CAP
	});
	if (logId === null) return 'skipped';

	const messageIds = email.messageId ?? [];
	const reply: Record<string, unknown> = {
		mailboxIds: { [opts.mailboxId]: true },
		keywords: { $seen: true },
		from: [{ name: identity.name, email: identity.email }],
		to: [opts.to],
		subject: opts.settings.subject.trim() || `Automatic reply: ${email.subject ?? ''}`.trim(),
		bodyValues: { text: { value: opts.settings.body, charset: 'utf-8' } },
		textBody: [{ partId: 'text', type: 'text/plain' }],
		// Marked as automatic, so other responders don't answer it, and
		// threaded with the message it answers.
		'header:Auto-Submitted:asText': 'auto-replied',
		'header:X-Auto-Response-Suppress:asText': 'All',
		...(messageIds.length > 0 && { inReplyTo: messageIds, references: [...(email.references ?? []), ...messageIds] })
	};

	// 1. The copy. Nothing can have been sent if this fails, however it fails.
	let copyId: string | undefined;
	let copyError: unknown;
	try {
		const created = setResult(await client.request([['Email/set', { accountId, create: { reply } }, '0']]), 'Email/set');
		copyId = created?.created?.reply?.id;
		if (!copyId) copyError = new Error(reasonOf(created?.notCreated?.reply, 'the reply was not created'));
	} catch (err) {
		copyError = err;
	}
	if (!copyId) {
		removeAutoReplyLog(logId);
		console.warn('[auto-reply] could not create the reply', copyError);
		logEvent('warn', 'auto_reply', 'send_failed', { ...fields, ...errorFields(copyError) });
		return 'refused';
	}

	// 2. The submission.
	let outcome: SendOutcome;
	let failure: unknown;
	try {
		const submitted = setResult(
			await client.request([
				[
					'EmailSubmission/set',
					{
						accountId,
						create: {
							sub: {
								emailId: copyId,
								identityId: identity.id,
								envelope: { mailFrom: { email: identity.email }, rcptTo: [{ email: opts.to.email }] }
							}
						},
						onSuccessDestroyEmail: ['#sub']
					},
					'0'
				]
			]),
			'EmailSubmission/set'
		);
		if (submitted?.created?.sub) outcome = 'sent';
		else if (submitted?.notCreated?.sub) {
			outcome = 'refused';
			failure = new Error(reasonOf(submitted.notCreated.sub, 'the reply was not sent'));
		} else {
			// An answer that says neither: it may have gone.
			outcome = 'uncertain';
			failure = new Error('the server did not say whether the reply was sent');
		}
	} catch (err) {
		// A method-level error is the server refusing the call; anything
		// else (timeout, dropped connection, a 5xx) may have come after it
		// sent the mail.
		outcome = err instanceof JMAPMethodError ? 'refused' : 'uncertain';
		failure = err;
	}

	if (outcome === 'sent') {
		logEvent('info', 'auto_reply', 'sent', fields);
		return outcome;
	}
	if (outcome === 'refused') {
		removeAutoReplyLog(logId);
		console.warn('[auto-reply] send refused', failure);
		logEvent('warn', 'auto_reply', 'send_failed', { ...fields, ...errorFields(failure) });
	} else {
		console.warn('[auto-reply] send may or may not have gone; not trying again today', failure);
		logEvent('warn', 'auto_reply', 'send_uncertain', { ...fields, ...errorFields(failure) });
	}
	// Not surely sent, so the copy may still be in Drafts. One attempt; its
	// failure changes nothing above.
	try {
		await client.request([['Email/set', { accountId, destroy: [copyId] }, '0']]);
	} catch (err) {
		logEvent('warn', 'auto_reply', 'copy_not_destroyed', { ...fields, ...errorFields(err) });
	}
	return outcome;
}

/** Out-of-office for one mail account's run, when it is on for that account's login. */
export interface OutOfOffice {
	accountRowId: string;
	accountEmail: string;
	userId: string;
	settings: AutoReplySettings;
}

/** Out-of-office for the mail account with this address, or null when it isn't on. */
export function outOfOfficeFor(accountEmail: string, now = new Date()): OutOfOffice | null {
	const id = accountIdForEmail(accountEmail);
	const account = id ? getAccount(id) : undefined;
	if (!account) return null;
	const settings = autoReplySettings(getPrefs(account.user_id));
	if (!autoReplyActiveAt(settings, now)) return null;
	return { accountRowId: account.id, accountEmail: account.email, userId: account.user_id, settings };
}

/** The identity replies go from: the cached primary, else what the server lists. */
async function replyIdentity(client: JMAPClient, accountId: string, accountEmail: string): Promise<ReplyIdentity | null> {
	const cached = listIdentities(accountEmail);
	const pick = cached.find((i) => i.isPrimary) ?? cached[0];
	if (pick?.jmapId) return { id: pick.jmapId, email: pick.email, name: pick.name };
	const listed = await getIdentities(client, accountId);
	const own = listed.find((i) => normalizeAddress(i.email) === normalizeAddress(accountEmail)) ?? listed[0];
	return own ? { id: own.id, email: own.email, name: own.name } : null;
}

/**
 * Answer the new Inbox messages of one account's run that should be
 * answered, as they arrived (before rules move them).
 */
export async function answerNewMail(
	client: JMAPClient,
	accountId: string,
	ooo: OutOfOffice,
	emails: Email[],
	mailboxes: Mailbox[],
	now = new Date()
): Promise<void> {
	if (emails.length === 0) return;
	const identitiesOf = (address: string) => [normalizeAddress(address), ...listIdentities(address).map((i) => normalizeAddress(i.email))];
	const accountAddresses = new Set(identitiesOf(ooo.accountEmail));
	const ownAddresses = new Set(accountAddresses);
	for (const account of listAccounts(ooo.userId)) for (const a of identitiesOf(account.email)) ownAddresses.add(a);
	const ctx: ReplyContext = {
		settings: ooo.settings,
		now,
		accountEmail: ooo.accountEmail,
		accountAddresses,
		ownAddresses,
		answered: sendersAnsweredSince(ooo.userId, new Date(now.getTime() - DAY).toISOString()),
		sentLastHour: repliesSentSince(ooo.userId, new Date(now.getTime() - HOUR).toISOString())
	};
	const mailboxId = (mailboxes.find((m) => m.role === 'drafts') ?? mailboxes.find((m) => m.role === 'sent'))?.id;
	let identity: ReplyIdentity | null | undefined;

	for (const email of emails) {
		const decision = shouldAutoReply(email, ctx);
		if ('skip' in decision) continue;
		identity ??= await replyIdentity(client, accountId, ooo.accountEmail);
		if (!identity || !mailboxId) {
			logEvent('warn', 'auto_reply', 'cannot_send', { account: ooo.accountRowId, reason: identity ? 'no Drafts folder' : 'no identity' });
			return;
		}
		await sendAutoReply(client, email, {
			accountId,
			logAccountId: ooo.accountRowId,
			userId: ooo.userId,
			to: decision.to,
			sender: decision.sender,
			settings: ooo.settings,
			identity,
			mailboxId,
			now
		});
		// Counted even when the send failed, so one batch can't keep trying.
		ctx.answered.add(decision.sender);
		ctx.sentLastHour++;
	}
}

/** The daily pass: forget replies older than a month. */
export function pruneOldAutoReplies(now = new Date()): void {
	pruneAutoReplyLog(new Date(now.getTime() - KEEP_LOG_DAYS * DAY).toISOString());
}
