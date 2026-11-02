import { env } from '$env/dynamic/private';

/**
 * The Telegram Bot API, called with plain fetch. The token is read here and
 * nowhere else, never logged, and never reaches the browser.
 */

const API = 'https://api.telegram.org';

export class TelegramError extends Error {
	constructor(
		message: string,
		public status: number,
		/** Seconds Telegram asks to wait, on a 429. */
		public retryAfter: number | null = null
	) {
		super(message);
		this.name = 'TelegramError';
	}
}

/**
 * Worth trying again later: anything but a 400 or 403, which mean the chat
 * is gone or the bot was blocked. A 401 or 404 is the bot token itself
 * (revoked, mistyped), so messages wait for it to be fixed.
 */
export function retryable(err: unknown): boolean {
	return !(err instanceof TelegramError) || (err.status !== 400 && err.status !== 403);
}

export function telegramConfigured(): boolean {
	return !!env.TELEGRAM_BOT_TOKEN;
}

async function call<T>(method: string, body: Record<string, unknown>, timeoutMs = 15_000): Promise<T> {
	const res = await fetch(`${API}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(timeoutMs)
	});
	const data = (await res.json().catch(() => null)) as {
		ok?: boolean;
		result?: T;
		description?: string;
		parameters?: { retry_after?: number };
	} | null;
	if (!data?.ok) throw new TelegramError(data?.description ?? `HTTP ${res.status}`, res.status, data?.parameters?.retry_after ?? null);
	return data.result as T;
}

export type InlineButton = { text: string; callback_data: string } | { text: string; url: string };

export interface TelegramUpdate {
	update_id: number;
	message?: { message_id: number; chat: { id: number; type: string }; from?: { username?: string }; text?: string };
	callback_query?: {
		id: string;
		data?: string;
		message?: { message_id: number; chat: { id: number } };
	};
}

export function sendMessage(chatId: string, html: string, buttons: InlineButton[][] = []): Promise<unknown> {
	return call('sendMessage', {
		chat_id: chatId,
		text: html,
		parse_mode: 'HTML',
		link_preview_options: { is_disabled: true },
		...(buttons.length ? { reply_markup: { inline_keyboard: buttons } } : {})
	});
}

export function answerCallback(id: string, text: string): Promise<unknown> {
	return call('answerCallbackQuery', { callback_query_id: id, text });
}

/** Drop a message's buttons once one has been used. */
export function clearButtons(chatId: string, messageId: number): Promise<unknown> {
	return call('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } });
}

/** Long poll: Telegram holds the request open until something arrives. */
export function getUpdates(offset: number): Promise<TelegramUpdate[]> {
	return call('getUpdates', { offset, timeout: 50, allowed_updates: ['message', 'callback_query'] }, 65_000);
}

let botName: Promise<string> | null = null;

/** The bot's @username, for the t.me link. */
export function botUsername(): Promise<string> {
	botName ??= call<{ username: string }>('getMe', {}).then((me) => me.username);
	botName.catch(() => (botName = null));
	return botName;
}

/** Telegram's HTML mode: only these three characters need escaping. */
export function escapeHtml(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
