import { env } from '$env/dynamic/private';
import { createClient } from '$lib/jmap/auth';
import { moveEmails, updateEmailMailboxes } from '$lib/jmap/email';
import { ensureArchiveMailbox, ensureRemindMeLaterMailbox, getMailboxes } from '$lib/jmap/mailbox';
import { labelMailboxIds } from '$lib/types/labels';
import { authStateForAccount, getAccount, listAccounts } from '$lib/server/auth/accounts';
import { scheduleReminder } from '$lib/server/db/queries/reminders';
import { recordAudit } from '$lib/server/agent/store';
import { errorFields, logEvent } from '$lib/server/log';
import {
	answerCallback,
	clearButtons,
	escapeHtml,
	retryable,
	sendMessage,
	telegramConfigured,
	TelegramError,
	type InlineButton,
	type TelegramUpdate
} from './bot';
import {
	claimAlert,
	claimReminder,
	createButton,
	dueAlerts,
	dueReminders,
	finishAlert,
	getLink,
	getLinkByChat,
	holdAlertUntil,
	linkChatWithCode,
	markReminderSent,
	queueAlert,
	releaseButton,
	releaseReminder,
	retryAlertAt,
	setLinkFlags,
	takeButton,
	type ButtonToken
} from './store';

/**
 * What the bot sends (urgent mail, reminders) and how it answers. It acts on
 * nothing typed into the chat: the only inputs are the one-time /start code,
 * /stop, and buttons it sent itself, each of which names a reversible action
 * on one email.
 */

const MAX_PER_HOUR = 20;
const HOUR_MS = 3_600_000;
const SNOOZE_MS = 60 * 60 * 1000;
// An urgent alert Telegram still hasn't taken after this long is stale news;
// a notice from Zajel itself (a lost sign-in) keeps for a week.
const ALERT_EXPIRY_MS = 12 * HOUR_MS;
const NOTICE_EXPIRY_MS = 7 * 24 * HOUR_MS;
// How long a notice waits while alerts are paused before looking again.
const PAUSED_RECHECK_MS = 5 * 60_000;
const BUTTON_TIMEOUT_MS = 20_000;
const sentLog = new Map<string, number[]>();
const cappedLogged = new Map<string, number>();

/** A burst of mail can't turn into a burst of pings. */
function allowSend(userId: string, nowMs = Date.now()): boolean {
	const recent = (sentLog.get(userId) ?? []).filter((t) => nowMs - t < HOUR_MS);
	if (recent.length >= MAX_PER_HOUR) return false;
	recent.push(nowMs);
	sentLog.set(userId, recent);
	return true;
}

/** A send that failed doesn't use up the hour. */
function giveBackSend(userId: string): void {
	sentLog.get(userId)?.pop();
}

function capFreesAt(userId: string, nowMs: number): number {
	const recent = (sentLog.get(userId) ?? []).filter((t) => nowMs - t < HOUR_MS);
	return recent.length ? Math.min(...recent) + HOUR_MS : nowMs;
}

// While Telegram keeps failing, a send failure is logged when it starts or
// changes, and once when sending works again; not on every retry.
let sendFailure = '';

function noteSendFailure(event: string, fields: Record<string, unknown>): void {
	const text = `${event}:${String(fields.error)}`;
	if (text === sendFailure) return;
	sendFailure = text;
	logEvent('error', 'telegram', event, fields);
}

function noteSendOk(): void {
	if (!sendFailure) return;
	sendFailure = '';
	logEvent('info', 'telegram', 'send_recovered');
}

/** Links in messages only ever point at this app. */
function openUrl(emailId: string): string | null {
	const origin = env.ORIGIN?.replace(/\/+$/, '');
	return origin ? `${origin}/email/${encodeURIComponent(emailId)}` : null;
}

function emailButtons(userId: string, accountId: string, emailId: string): InlineButton[][] {
	const button = (text: string, action: ButtonToken['action']): InlineButton => ({
		text,
		callback_data: createButton({ userId, accountId, emailId, action })
	});
	const url = openUrl(emailId);
	return [
		[button('Mark read', 'read'), button('Snooze 1h', 'snooze'), button('Archive', 'archive')],
		...(url ? [[{ text: 'Open', url }]] : [])
	];
}

export function urgentAlertsWanted(accountRowId: string): boolean {
	if (!telegramConfigured()) return false;
	const account = getAccount(accountRowId);
	const link = account ? getLink(account.user_id) : null;
	return !!link && link.urgent && !link.paused;
}

type UrgentEmail = { id: string; subject?: string | null; from?: { name?: string | null; email: string }[] | null };

/**
 * Queue an alert about a message Jev judged urgent, without sending it:
 * flushAlerts sends it, now or on a later run if it fails or waits for the
 * hourly cap, so it is late rather than lost. An email is only ever alerted
 * once. Synchronous, so a pass can queue all its alerts before it sends any.
 * Returns the login to flush for, or null when nothing was queued.
 */
export function queueUrgent(accountRowId: string, email: UrgentEmail): string | null {
	const account = getAccount(accountRowId);
	if (!account || !urgentAlertsWanted(accountRowId)) return null;

	const sender = email.from?.[0];
	const several = listAccounts(account.user_id).length > 1;
	const html = [
		`<b>Urgent</b> · ${escapeHtml(sender?.name || sender?.email || 'Unknown sender')}`,
		escapeHtml(email.subject || '(no subject)'),
		...(several ? [`<i>${escapeHtml(account.email)}</i>`] : [])
	].join('\n');
	const summary = `Sent an urgent alert: “${(email.subject ?? '').slice(0, 80)}”`;
	return queueAlert({ userId: account.user_id, accountId: account.id, emailId: email.id, html, summary }) ? account.user_id : null;
}

/** Queue an alert (queueUrgent) and send it straight away. */
export async function notifyUrgent(accountRowId: string, email: UrgentEmail): Promise<void> {
	const userId = queueUrgent(accountRowId, email);
	if (userId) await flushAlerts(userId);
}

/**
 * Send the queued alerts that are due: one login's, or everyone's (the minute
 * cron). `nowMs` is for tests; otherwise each alert reads the clock afresh,
 * since one slow send can take 15 s and leases must stay ahead of it.
 */
export async function flushAlerts(userId: string | null = null, nowMs?: number): Promise<void> {
	if (!telegramConfigured()) return;
	const clock = () => nowMs ?? Date.now();
	for (const alert of dueAlerts(userId, clock())) {
		const now = clock();
		// Another run may be sending this one already.
		if (!claimAlert(alert.id, now)) continue;
		const notice = alert.kind === 'notice';
		const link = getLink(alert.userId);
		// Unlinked, or urgent alerts switched off, since it was queued: dropped,
		// as a new alert would be. Paused: an alert is dropped, while a notice
		// waits, so it is seen once alerts are back on.
		if (!link || (!notice && (link.paused || !link.urgent))) {
			finishAlert(alert.id, 'dropped', now);
			continue;
		}
		if (now - Date.parse(alert.createdAt) > (notice ? NOTICE_EXPIRY_MS : ALERT_EXPIRY_MS)) {
			finishAlert(alert.id, 'expired', now);
			logEvent('error', 'telegram', 'urgent_expired', { account: alert.accountId, kind: alert.kind, attempts: alert.attempts });
			continue;
		}
		if (link.paused) {
			holdAlertUntil(alert.id, now + PAUSED_RECHECK_MS);
			continue;
		}
		if (!notice && !allowSend(alert.userId, now)) {
			holdAlertUntil(alert.id, capFreesAt(alert.userId, now));
			if ((cappedLogged.get(alert.userId) ?? 0) + HOUR_MS < now) {
				cappedLogged.set(alert.userId, now);
				logEvent('warn', 'telegram', 'urgent_capped', { account: alert.accountId });
			}
			continue;
		}
		try {
			await sendMessage(link.chatId, alert.html, notice ? openButton() : emailButtons(link.userId, alert.accountId, alert.emailId));
			noteSendOk();
		} catch (err) {
			if (!notice) giveBackSend(alert.userId);
			const again = retryable(err);
			if (again) {
				const waitMs =
					err instanceof TelegramError && err.retryAfter ? err.retryAfter * 1000 : Math.min(30_000 * 2 ** alert.attempts, 10 * 60_000);
				retryAlertAt(alert.id, clock() + waitMs);
			} else {
				finishAlert(alert.id, 'refused', clock());
			}
			console.error('[telegram] alert failed', err instanceof Error ? err.message : err);
			noteSendFailure('urgent_failed', { account: alert.accountId, kind: alert.kind, retrying: again, ...errorFields(err) });
			// Telegram is failing: the rest wait for the next run.
			break;
		}
		if (finishAlert(alert.id, 'sent', clock()) && !notice) {
			recordAudit({
				userId: alert.userId,
				accountId: alert.accountId,
				source: 'telegram',
				tool: 'notify_urgent',
				tier: 'self',
				summary: alert.summary,
				outcome: 'done'
			});
		}
	}
}

function openButton(): InlineButton[][] {
	const origin = env.ORIGIN?.replace(/\/+$/, '');
	return origin ? [[{ text: 'Open', url: `${origin}/` }]] : [];
}

/**
 * Once, when an account's stored password stops working (markNeedsReauth):
 * every background pass for it stops, urgent alerts included, so the user
 * hears it rather than mistaking the quiet for no urgent mail. It goes
 * through the outbox like an alert, so a failed send is retried; it isn't
 * capped, and while alerts are paused it waits until they're back on.
 */
export async function notifySignInLost(accountRowId: string, nowMs = Date.now()): Promise<void> {
	if (!telegramConfigured()) return;
	const account = getAccount(accountRowId);
	if (!account || !getLink(account.user_id)) return;
	const html = `<b>Zajel can’t sign in</b> to ${escapeHtml(account.email)}. Urgent alerts and reminders for it are off until you sign in again.`;
	queueAlert({ kind: 'notice', userId: account.user_id, accountId: account.id, emailId: `reauth:${nowMs}`, html, summary: '' }, nowMs);
	await flushAlerts(account.user_id);
}

/**
 * Settings → Notifications → Test alert: laid out like an urgent alert, so
 * you see what one looks like when it arrives. It names no email, so the only
 * button is Open (when ORIGIN is set). It counts toward the hourly cap, and
 * goes out even while paused, since you just asked for it.
 */
export async function sendTestAlert(userId: string): Promise<'sent' | 'not_linked' | 'limited'> {
	const link = getLink(userId);
	if (!link) return 'not_linked';
	if (!allowSend(userId)) return 'limited';
	const origin = env.ORIGIN?.replace(/\/+$/, '');
	try {
		await sendMessage(link.chatId, '<b>Urgent</b> · Zajel\nTest alert', origin ? [[{ text: 'Open', url: `${origin}/` }]] : []);
	} catch (err) {
		giveBackSend(userId);
		throw err;
	}
	recordAudit({
		userId,
		accountId: null,
		source: 'telegram',
		tool: 'notify_test',
		tier: 'self',
		summary: 'Sent a test alert',
		outcome: 'done'
	});
	return 'sent';
}

/** Send the agent's reminders that are due. */
export async function sendDueReminders(nowMs = Date.now()): Promise<void> {
	if (!telegramConfigured()) return;
	for (const reminder of dueReminders(nowMs)) {
		const link = getLink(reminder.userId);
		// Paused or unlinked: it waits rather than being lost.
		if (!link || link.paused || !claimReminder(reminder.id)) continue;
		const buttons = reminder.emailId && reminder.accountId ? emailButtons(link.userId, reminder.accountId, reminder.emailId) : [];
		try {
			await sendMessage(link.chatId, `<b>Reminder</b>\n${escapeHtml(reminder.text)}`, buttons);
			markReminderSent(reminder.id);
			noteSendOk();
		} catch (err) {
			// Not delivered: give it back unless Telegram refused it for good,
			// and leave the rest for the next run.
			const again = retryable(err);
			if (again) releaseReminder(reminder.id);
			else markReminderSent(reminder.id);
			console.error('[telegram] reminder failed', err instanceof Error ? err.message : err);
			noteSendFailure('reminder_failed', { retrying: again, ...errorFields(err) });
			break;
		}
	}
}

async function runButton(token: ButtonToken): Promise<string> {
	const account = getAccount(token.accountId);
	if (!account || account.user_id !== token.userId) return 'That account is no longer linked';
	const auth = authStateForAccount(account);
	const client = createClient(auth);
	if (token.action === 'read') {
		await updateEmailMailboxes(client, auth.accountId, { [token.emailId]: { keywords: { $seen: true } } });
		return 'Marked read';
	}
	const boxes = await getMailboxes(client, auth.accountId);
	const labels = labelMailboxIds(boxes);
	if (token.action === 'archive') {
		const archive = await ensureArchiveMailbox(client, auth.accountId);
		if (!archive) return 'No Archive folder';
		await moveEmails(client, auth.accountId, [token.emailId], archive, undefined, labels);
		return 'Archived';
	}
	// Snooze: into Remind Me Later, back in an hour.
	const inbox = boxes.find((m) => m.role === 'inbox');
	const rml = await ensureRemindMeLaterMailbox(client, auth.accountId);
	if (!inbox || !rml) return 'Can’t snooze that';
	await moveEmails(client, auth.accountId, [token.emailId], rml, inbox.id, labels);
	scheduleReminder(account.email, auth.accountId, token.emailId, inbox.id, new Date(Date.now() + SNOOZE_MS).toISOString());
	return 'Snoozed for an hour';
}

/** One update from getUpdates. */
export async function handleUpdate(update: TelegramUpdate): Promise<void> {
	const query = update.callback_query;
	if (query) {
		const chatId = query.message ? String(query.message.chat.id) : '';
		const link = chatId ? getLinkByChat(chatId) : null;
		const token = link && query.data ? takeButton(query.data) : null;
		if (!link || !token || token.userId !== link.userId) {
			await answerCallback(query.id, 'This button has expired');
			return;
		}
		const buttonId = query.data!;
		const messageId = query.message?.message_id;
		const audit = (summary: string, outcome: 'done' | 'failed') =>
			recordAudit({ userId: link.userId, accountId: token.accountId, source: 'telegram', tool: `button_${token.action}`, tier: 'self', summary, outcome });
		// What happens once the action has really finished, however long it took.
		const action = runButton(token).then(
			async (result) => {
				audit(result, 'done');
				if (messageId !== undefined) await clearButtons(chatId, messageId).catch(() => {});
				return result;
			},
			(err) => {
				// Not done: the button works again, and stays on the message.
				releaseButton(buttonId);
				audit('That didn’t work', 'failed');
				logEvent('error', 'telegram', 'button_failed', { action: token.action, ...errorFields(err) });
				return 'That didn’t work';
			}
		);
		// The answer is bounded, so a mail server that never replies can't hold
		// up the poll loop, and with it /stop and every other button. The action
		// itself carries on, and the button stays spent until it settles.
		let timer: ReturnType<typeof setTimeout> | undefined;
		const slow = new Promise<string>((resolve) => {
			timer = setTimeout(() => resolve('The mail server is slow; this may still go through'), BUTTON_TIMEOUT_MS);
		});
		const reply = await Promise.race([action, slow]);
		clearTimeout(timer);
		await answerCallback(query.id, reply).catch(() => {});
		return;
	}

	const message = update.message;
	// Only private chats: a group would put the alerts in front of others.
	if (!message?.text || message.chat.type !== 'private') return;
	const chatId = String(message.chat.id);
	const [command, arg] = message.text.trim().split(/\s+/, 2);

	if (command === '/start' && arg) {
		const userId = linkChatWithCode(arg, chatId, message.from?.username ?? null);
		await sendMessage(chatId, userId ? 'Linked. Urgent mail and reminders will come here. Send /stop to pause.' : 'That link has expired. Make a new one in Zajel’s settings.');
		return;
	}
	if (command === '/stop') {
		const link = getLinkByChat(chatId);
		if (link) setLinkFlags(link.userId, { paused: true });
		await sendMessage(chatId, link ? 'Paused. Turn alerts back on in Zajel’s settings.' : 'This chat isn’t linked.');
	}
	// Anything else is ignored: nothing typed here is acted on.
}
