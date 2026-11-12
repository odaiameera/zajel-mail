import { env } from '$env/dynamic/private';
import type { AuthState } from '$lib/jmap/types';
import { authStateForAccount, getAccount, listAccounts, type MailAccountRow } from '$lib/server/auth/accounts';
import { claudeConfigured } from '$lib/server/ai/claude';
import { localDate } from '$lib/server/ai/mail-agent';
import { MailAssistantError } from '$lib/server/ai/mail-assistant';
import { decidePendingAction, pendingView, STEP_UP_KINDS, type PendingView } from '$lib/server/agent/actions';
import { sendSavedDraft } from '$lib/server/agent/compose';
import { runAgentTurn, type AgentTurnResult } from '$lib/server/agent/runtime';
import {
	endTurnJournal,
	getPendingAction,
	noteTurnProgress,
	recordAudit,
	startTurnJournal,
	takeInterruptedTurns,
	type PendingAction
} from '$lib/server/agent/store';
import type { SavedDraft } from '$lib/server/agent/tools';
import { parseUndoSendSeconds } from '$lib/server/compose-input';
import { appendMessage, conversationExists, createConversation, listMessages } from '$lib/server/db/queries/ai-conversations';
import { getPrefs } from '$lib/server/db/queries/app-prefs';
import { errorFields, logEvent } from '$lib/server/log';
import { cancelScheduledSend } from '$lib/server/scheduled-send';
import { answerCallback, clearButtons, escapeHtml, sendMessage, sendTyping, type InlineButton } from './bot';
import { markdownPieces, packMessages, plainPiece, type Piece } from './format';
import { createAgentButton, getLink, releaseAgentButton, setLinkConversation, takeAgentButton, type AgentButton, type TelegramLink } from './store';

/**
 * Talking to Zajel in the linked Telegram chat. A message typed there is an
 * agent turn, as in the web panel, in one running conversation (/new starts
 * another); it shows in the panel's history as "Telegram". What Zajel would
 * send, add or delete comes as a card, and a draft it saves comes with Send:
 * either is a button press away (or, with that switched off in Settings,
 * confirmed in the web app). Nothing leaves the account without a press.
 *
 * Only the linked private chat gets here (notifier.handleUpdate). A turn
 * can take a couple of minutes, so it runs off the poll loop, one at a time
 * per user.
 */

const MAX_MESSAGE = 1_500;
const HISTORY = 12;
const MAX_TURNS_PER_HOUR = 40;
const HOUR_MS = 3_600_000;
const TYPING_EVERY_MS = 4_500;
const CONVERSATION_TITLE = 'Telegram';

const running = new Set<string>();
const turnLog = new Map<string, number[]>();

/** A lost phone in the wrong hands, or a loop, can't run up the model bill. */
function allowTurn(userId: string, nowMs = Date.now()): boolean {
	const recent = (turnLog.get(userId) ?? []).filter((t) => nowMs - t < HOUR_MS);
	if (recent.length >= MAX_TURNS_PER_HOUR) return false;
	recent.push(nowMs);
	turnLog.set(userId, recent);
	return true;
}

/** For tests: forget who is busy and how many turns they've had. */
export function resetChatState(): void {
	running.clear();
	turnLog.clear();
}

/** A link into this app, when it knows its own address (ORIGIN). */
function appUrl(path: string): string | null {
	const origin = env.ORIGIN?.replace(/\/+$/, '');
	return origin ? `${origin}${path}` : null;
}

/** Said to the model: where it is, and how the user answers its cards here. */
function telegramNote(link: TelegramLink): string {
	return `The user is writing to you from Telegram on their phone: keep replies short. Anything you prepare to send, add or delete appears in the chat as a card ${
		link.confirmInChat ? 'with a button to confirm it' : 'that they confirm in the Zajel web app'
	}, and each draft you save appears with ${link.confirmInChat ? 'a Send button and ' : ''}a link to edit it in Zajel.`;
}

/** The pieces as messages, the buttons on the last one. */
async function sendPacked(chatId: string, head: string, pieces: Piece[], buttons: InlineButton[][], replyTo?: number): Promise<void> {
	const messages = packMessages(head, pieces);
	for (const [i, html] of messages.entries()) {
		await sendMessage(chatId, html, i === messages.length - 1 ? buttons : [], i === 0 ? replyTo : undefined);
	}
}

const say = (chatId: string, text: string, replyTo?: number) => sendMessage(chatId, escapeHtml(text), [], replyTo);

// --- cards ---------------------------------------------------------------------

/**
 * A card in the chat: exactly what will run, whole (over several messages if
 * it's long), with Confirm and Cancel on the last. With confirming here
 * switched off, or for a kind that needs a fresh re-check, the web app it is.
 */
export async function sendCard(link: TelegramLink, action: PendingAction, replyTo?: number): Promise<void> {
	const view: PendingView = pendingView(action);
	const head = `<b>${escapeHtml(view.label)}</b>${view.title ? ` · ${escapeHtml(view.title)}` : ''}`;
	const pieces = [
		...(view.lines.length ? [plainPiece(view.lines.filter(Boolean).join('\n'), true)] : []),
		...(view.body ? [plainPiece(view.body)] : [])
	];
	if (link.confirmInChat && !STEP_UP_KINDS.has(action.kind)) {
		const button = (kind: AgentButton['kind']) => createAgentButton({ userId: link.userId, accountId: action.accountId, kind, ref: action.id });
		const buttons = [[{ text: view.confirmLabel, callback_data: button('confirm') }, { text: 'Cancel', callback_data: button('cancel') }]];
		await sendPacked(link.chatId, head, pieces, buttons, replyTo);
		return;
	}
	const url = appUrl('/');
	pieces.push(plainPiece(`Confirm it in Zajel, in the “${CONVERSATION_TITLE}” conversation.`));
	await sendPacked(link.chatId, head, pieces, url ? [[{ text: 'Open Zajel', url }]] : [], replyTo);
}

/** A draft Zajel saved: what it says, Send (when confirming here is on), and a link to edit it. */
export async function sendDraftCard(link: TelegramLink, accountId: string, draft: SavedDraft, replyTo?: number): Promise<void> {
	const head = `<b>${draft.replyToEmailId ? 'Draft reply' : 'Draft'}</b> · ${escapeHtml(draft.subject)}`;
	const pieces = [plainPiece(`To ${draft.to.join(', ')}`, true), plainPiece(draft.text)];
	const url = appUrl(`/email/${encodeURIComponent(draft.id)}`);
	const row: InlineButton[] = [
		...(link.confirmInChat ? [{ text: 'Send', callback_data: createAgentButton({ userId: link.userId, accountId, kind: 'send_draft', ref: draft.id }) }] : []),
		...(url ? [{ text: 'Edit in Zajel', url }] : [])
	];
	if (!url) pieces.push(plainPiece('It’s in your Drafts.'));
	await sendPacked(link.chatId, head, pieces, row.length ? [row] : [], replyTo);
}

/** A turn's answer, what it changed, then its cards and drafts. */
async function deliver(link: TelegramLink, accountId: string, result: AgentTurnResult, replyTo?: number): Promise<void> {
	const changes = result.done.map((d, i) => plainPiece(`• ${d.replace(/\s+/g, ' ')}`, i > 0));
	await sendPacked(link.chatId, '', [...markdownPieces(result.message), ...changes], [], replyTo);
	for (const action of result.pending) await sendCard(link, action);
	for (const draft of result.drafts) await sendDraftCard(link, accountId, draft);
}

// --- turns ---------------------------------------------------------------------

/** The account a turn works in: the one named (an alert's), or the first linked. */
function accountFor(userId: string, accountId?: string): MailAccountRow | null {
	if (accountId) {
		const account = getAccount(accountId);
		return account && account.user_id === userId ? account : null;
	}
	return listAccounts(userId)[0] ?? null;
}

/**
 * The chat's conversation, in the default account's history. A turn in
 * another account (a reply to that account's alert) gets one of its own.
 */
function conversationFor(link: TelegramLink, account: MailAccountRow, isDefault: boolean): string {
	if (!isDefault) return createConversation(account.email, Date.now(), CONVERSATION_TITLE);
	if (link.conversationId && conversationExists(link.conversationId, account.email)) return link.conversationId;
	const id = createConversation(account.email, Date.now(), CONVERSATION_TITLE);
	setLinkConversation(link.userId, id);
	return id;
}

/** /new: the next message starts a fresh conversation. */
export function startNewConversation(link: TelegramLink): void {
	const account = accountFor(link.userId);
	if (account) setLinkConversation(link.userId, createConversation(account.email, Date.now(), CONVERSATION_TITLE));
}

/**
 * One message typed in the chat (or a button that asks Zajel something),
 * answered as an agent turn. Never throws: whatever goes wrong is said in
 * the chat.
 */
export async function chatInTelegram(link: TelegramLink, text: string, opts: { replyTo?: number; accountId?: string } = {}): Promise<void> {
	const { chatId, userId } = link;
	try {
		if (!claudeConfigured()) {
			await say(chatId, 'Chatting with Zajel here needs Claude as the AI provider (Settings → Agent).', opts.replyTo);
			return;
		}
		if (running.has(userId)) {
			await say(chatId, 'I’m still working on your last message. Send this again once I’ve answered.', opts.replyTo);
			return;
		}
		if (!allowTurn(userId)) {
			await say(chatId, 'That’s a lot of messages for one hour. Try again a little later.', opts.replyTo);
			return;
		}
		const account = accountFor(userId, opts.accountId);
		if (!account) {
			await say(chatId, 'There’s no mail account linked in Zajel to work in.', opts.replyTo);
			return;
		}
		let auth: AuthState | null = null;
		try {
			if (!account.needs_reauth) auth = authStateForAccount(account);
		} catch {
			// An undecryptable secret: the same as a lost sign-in.
		}
		if (!auth) {
			await say(chatId, `Sign in to ${account.email} in Zajel again first.`, opts.replyTo);
			return;
		}

		running.add(userId);
		void sendTyping(chatId).catch(() => {});
		const typing = setInterval(() => void sendTyping(chatId).catch(() => {}), TYPING_EVERY_MS);
		try {
			const isDefault = !opts.accountId || listAccounts(userId)[0]?.id === account.id;
			await runTurn(link, account, auth, text.trim().slice(0, MAX_MESSAGE), conversationFor(link, account, isDefault), opts.replyTo);
		} finally {
			clearInterval(typing);
			running.delete(userId);
		}
	} catch (err) {
		logEvent('error', 'telegram', 'chat_failed', errorFields(err));
		await say(chatId, 'Something went wrong there. Try again in a moment.', opts.replyTo).catch(() => {});
	}
}

async function runTurn(
	link: TelegramLink,
	account: MailAccountRow,
	auth: AuthState,
	message: string,
	conversationId: string,
	replyTo?: number
): Promise<void> {
	const userEmail = account.email;
	// As in the web panel: a turn cut short (a restart) put what it did into
	// the transcript first, so it isn't done again.
	for (const lost of takeInterruptedTurns(link.userId, conversationId)) {
		appendMessage(conversationId, userEmail, 'user', lost.message);
		appendMessage(conversationId, userEmail, 'assistant', `I was interrupted before I could answer. Done before that: ${lost.done.join('; ')}.`);
	}
	const history = listMessages(conversationId, userEmail)
		.slice(-HISTORY)
		.map((m) => ({ role: m.role, content: m.content.slice(0, MAX_MESSAGE) }));
	const timeZone = link.timeZone ?? 'UTC';
	const journal = startTurnJournal({ userId: link.userId, accountId: account.id, conversationId, message });

	let result: AgentTurnResult;
	try {
		result = await runAgentTurn({
			auth,
			userId: link.userId,
			userEmail,
			accountRowId: account.id,
			conversationId,
			source: 'telegram',
			message,
			history,
			timeZone,
			today: localDate(Date.now(), timeZone),
			onProgress: (done) => noteTurnProgress(journal, done),
			note: telegramNote(link)
		});
	} catch (err) {
		if (!(err instanceof MailAssistantError)) throw err;
		await say(link.chatId, err.message, replyTo);
		return;
	}
	// A refusal stays out of the transcript, as in the web panel.
	if (result.outcome !== 'refused') {
		appendMessage(conversationId, userEmail, 'user', message);
		appendMessage(conversationId, userEmail, 'assistant', result.message);
	}
	endTurnJournal(journal);
	await deliver(link, account.id, result, replyTo);
}

// --- buttons -------------------------------------------------------------------

function ownAccount(button: AgentButton): MailAccountRow | null {
	const account = getAccount(button.accountId);
	return account && account.user_id === button.userId ? account : null;
}

function undoButton(userId: string, accountId: string, scheduledEmailId: string): InlineButton[][] {
	return [[{ text: 'Undo', callback_data: createAgentButton({ userId, accountId, kind: 'undo_send', ref: scheduledEmailId }) }]];
}

/**
 * A press on one of Zajel's buttons in the chat. Answers the press at once
 * and does the work after, so a slow mail server holds up nothing; the
 * outcome comes as a reply to the card. Never throws.
 */
export async function pressAgentButton(link: TelegramLink, queryId: string, buttonId: string, messageId?: number): Promise<void> {
	const button = takeAgentButton(buttonId);
	if (!button || button.userId !== link.userId) {
		await answerCallback(queryId, 'This button has expired').catch(() => {});
		return;
	}
	const { chatId, userId } = link;
	const clear = () => (messageId === undefined ? Promise.resolve() : clearButtons(chatId, messageId).catch(() => {}));
	const audit = (tool: string, summary: string, outcome: 'done' | 'failed') =>
		recordAudit({ userId, accountId: button.accountId, source: 'telegram', tool, tier: 'outward', summary, outcome });

	try {
		// The setting may have changed since the card went out: it decides now.
		const current = getLink(userId);
		if ((button.kind === 'confirm' || button.kind === 'send_draft') && !current?.confirmInChat) {
			releaseAgentButton(buttonId);
			await answerCallback(queryId, 'Confirming from Telegram is off. Confirm it in Zajel.');
			return;
		}

		switch (button.kind) {
			case 'confirm':
			case 'cancel': {
				const action = getPendingAction(userId, button.ref);
				if (button.kind === 'confirm' && action && STEP_UP_KINDS.has(action.kind)) {
					releaseAgentButton(buttonId);
					await answerCallback(queryId, 'Confirm this one in Zajel');
					return;
				}
				await answerCallback(queryId, button.kind === 'confirm' ? 'Working on it…' : 'Cancelled');
				const result = await decidePendingAction(userId, button.ref, button.kind, 'telegram');
				await clear();
				await sendMessage(
					chatId,
					escapeHtml(result.status === 200 && button.kind === 'cancel' ? 'Cancelled. Nothing was changed.' : result.message),
					result.scheduled ? undoButton(userId, button.accountId, result.scheduled.emailId) : [],
					messageId
				);
				return;
			}

			case 'send_draft': {
				const account = ownAccount(button);
				if (!account) {
					await answerCallback(queryId, 'That account is no longer linked');
					return;
				}
				await answerCallback(queryId, 'Sending…');
				const undo = parseUndoSendSeconds(getPrefs(userId).undo_send_seconds);
				const result = await sendSavedDraft(authStateForAccount(account), account.id, account.email, button.ref, undo);
				if (!result.success) {
					releaseAgentButton(buttonId);
					audit('send_draft', result.error, 'failed');
					await say(chatId, result.error, messageId);
					return;
				}
				await clear();
				const to = result.to.join(', ');
				audit('send_draft', `${result.scheduled ? 'Sending' : 'Sent'} the draft to ${to}`, 'done');
				await sendMessage(
					chatId,
					escapeHtml(result.scheduled ? `Sending to ${to} in ${undo} seconds.` : `Sent to ${to}.`),
					result.scheduled ? undoButton(userId, account.id, result.scheduled.emailId) : [],
					messageId
				);
				return;
			}

			case 'undo_send': {
				const account = ownAccount(button);
				if (!account) {
					await answerCallback(queryId, 'That account is no longer linked');
					return;
				}
				const result = await cancelScheduledSend(account.id, authStateForAccount(account), button.ref);
				if (!result.success && result.code === 'unreachable') {
					releaseAgentButton(buttonId);
					await answerCallback(queryId, result.error);
					return;
				}
				await answerCallback(queryId, result.success ? 'Not sent' : result.code === 'move-failed' ? 'Not sent' : 'Too late');
				await clear();
				const url = result.success ? appUrl(`/email/${encodeURIComponent(result.draftId)}`) : null;
				const text = result.success
					? 'Not sent. It’s back in your Drafts.'
					: result.code === 'move-failed'
						? 'Not sent, but it’s still in Scheduled.'
						: 'Too late: it has already gone.';
				if (result.success || result.code === 'move-failed') audit('undo_send', text, 'done');
				await sendMessage(chatId, escapeHtml(text), url ? [[{ text: 'Edit in Zajel', url }]] : [], messageId);
				return;
			}

			case 'draft_reply': {
				await answerCallback(queryId, 'Drafting a reply…');
				// Asked as if typed, so the reply is in the conversation; in the
				// account the alert came from.
				await chatInTelegram(
					link,
					`Draft a reply to the email id=${button.ref} and save it to Drafts. If answering it needs a decision only I can make, ask me instead of guessing.`,
					{ replyTo: messageId, accountId: button.accountId }
				);
				return;
			}
		}
	} catch (err) {
		releaseAgentButton(buttonId);
		logEvent('error', 'telegram', 'agent_button_failed', { kind: button.kind, ...errorFields(err) });
		await say(chatId, 'That didn’t work. Try the button again in a moment.', messageId).catch(() => {});
	}
}
