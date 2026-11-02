import cron from 'node-cron';
import { getUpdates, telegramConfigured, TelegramError } from './bot';
import { handleUpdate, sendDueReminders } from './notifier';
import { getState, setState } from './store';
import { errorFields, logEvent } from '$lib/server/log';

/**
 * The bot's background work: a long poll for button presses and /start or
 * /stop, and a once-a-minute check for due reminders. Long polling means
 * Telegram needs no way in to this server.
 */

const OFFSET_KEY = 'update_offset';
let started = false;

async function pollForever(): Promise<void> {
	let offset = Number(getState(OFFSET_KEY) ?? 0);
	// A failing poll retries every few seconds; it is logged when it starts
	// failing, or fails differently, not on every retry.
	let lastFailure = '';
	for (;;) {
		try {
			const updates = await getUpdates(offset);
			lastFailure = '';
			for (const update of updates) {
				await handleUpdate(update).catch((err) => {
					console.error('[telegram] update failed', err instanceof Error ? err.message : err);
					logEvent('error', 'telegram', 'update_failed', errorFields(err));
				});
				offset = update.update_id + 1;
				setState(OFFSET_KEY, String(offset));
			}
		} catch (err) {
			// 409 means another copy of the app is polling with the same token.
			const status = err instanceof TelegramError ? err.status : 0;
			if (status === 401) {
				console.error('[telegram] TELEGRAM_BOT_TOKEN was rejected; the bot is off until it is fixed');
				logEvent('error', 'telegram', 'token_rejected');
				return;
			}
			const fields = errorFields(err);
			if (fields.error !== lastFailure) {
				lastFailure = String(fields.error);
				logEvent('warn', 'telegram', 'poll_failed', { ...fields, ...(status === 409 ? { cause: 'another instance is polling with this token' } : {}) });
			}
			await new Promise((resolve) => setTimeout(resolve, status === 409 ? 30_000 : 5_000));
		}
	}
}

export function startTelegramWorker(): void {
	if (started || !telegramConfigured()) return;
	started = true;
	void pollForever();
	cron.schedule('* * * * *', () => {
		sendDueReminders().catch((err) => {
			console.error('[telegram] reminders failed', err instanceof Error ? err.message : err);
			logEvent('error', 'telegram', 'reminders_failed', errorFields(err));
		});
	});
}
