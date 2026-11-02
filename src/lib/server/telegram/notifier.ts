import { env } from '$env/dynamic/private';
import { createClient } from '$lib/jmap/auth';
import { moveEmails, updateEmailMailboxes } from '$lib/jmap/email';
import { ensureArchiveMailbox, ensureRemindMeLaterMailbox, getMailboxes } from '$lib/jmap/mailbox';
import { labelMailboxIds } from '$lib/types/labels';
import { authStateForAccount, getAccount, listAccounts } from '$lib/server/auth/accounts';
import { scheduleReminder } from '$lib/server/db/queries/reminders';
import { recordAudit } from '$lib/server/agent/store';
import {
	answerCallback,
	clearButtons,
	escapeHtml,
	sendMessage,
	telegramConfigured,
	type InlineButton,
	type TelegramUpdate
} from './bot';
import {
	createButton,
	dueReminders,
	getLink,
	getLinkByChat,
	linkChatWithCode,
	markReminderSent,
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
const SNOOZE_MS = 60 * 60 * 1000;
const sentLog = new Map<string, number[]>();

/** A burst of mail can't turn into a burst of pings. */
function allowSend(userId: string, nowMs = Date.now()): boolean {
	const recent = (sentLog.get(userId) ?? []).filter((t) => nowMs - t < 3_600_000);
	if (recent.length >= MAX_PER_HOUR) return false;
	recent.push(nowMs);
	sentLog.set(userId, recent);
	return true;
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

/** Tell the linked chat about a message Jev judged urgent. */
export async function notifyUrgent(
	accountRowId: string,
	email: { id: string; subject?: string | null; from?: { name?: string | null; email: string }[] | null }
): Promise<void> {
	const account = getAccount(accountRowId);
	if (!account || !urgentAlertsWanted(accountRowId)) return;
	const link = getLink(account.user_id)!;
	if (!allowSend(link.userId)) return;

	const sender = email.from?.[0];
	const several = listAccounts(account.user_id).length > 1;
	const html = [
		`<b>Urgent</b> · ${escapeHtml(sender?.name || sender?.email || 'Unknown sender')}`,
		escapeHtml(email.subject || '(no subject)'),
		...(several ? [`<i>${escapeHtml(account.email)}</i>`] : [])
	].join('\n');
	await sendMessage(link.chatId, html, emailButtons(link.userId, account.id, email.id));
	recordAudit({
		userId: link.userId,
		accountId: account.id,
		source: 'telegram',
		tool: 'notify_urgent',
		tier: 'self',
		summary: `Sent an urgent alert: “${(email.subject ?? '').slice(0, 80)}”`,
		outcome: 'done'
	});
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
	await sendMessage(link.chatId, '<b>Urgent</b> · Zajel\nTest alert', origin ? [[{ text: 'Open', url: `${origin}/` }]] : []);
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
		if (!link || link.paused || !markReminderSent(reminder.id)) continue;
		const buttons = reminder.emailId && reminder.accountId ? emailButtons(link.userId, reminder.accountId, reminder.emailId) : [];
		await sendMessage(link.chatId, `<b>Reminder</b>\n${escapeHtml(reminder.text)}`, buttons).catch((err) =>
			console.error('[telegram] reminder failed', err instanceof Error ? err.message : err)
		);
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
		const result = await runButton(token).catch(() => 'That didn’t work');
		recordAudit({
			userId: link.userId,
			accountId: token.accountId,
			source: 'telegram',
			tool: `button_${token.action}`,
			tier: 'self',
			summary: result,
			outcome: 'done'
		});
		await answerCallback(query.id, result);
		if (query.message) await clearButtons(chatId, query.message.message_id).catch(() => {});
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
