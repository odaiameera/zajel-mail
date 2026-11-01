import cron from 'node-cron';
import { getUpdates, telegramConfigured, TelegramError } from './bot';
import { handleUpdate, sendDueReminders } from './notifier';
import { getState, setState } from './store';

/**
 * The bot's background work: a long poll for button presses and /start or
 * /stop, and a once-a-minute check for due reminders. Long polling means
 * Telegram needs no way in to this server.
 */

const OFFSET_KEY = 'update_offset';
let started = false;

async function pollForever(): Promise<void> {
	let offset = Number(getState(OFFSET_KEY) ?? 0);
	for (;;) {
		try {
			const updates = await getUpdates(offset);
			for (const update of updates) {
				await handleUpdate(update).catch((err) =>
					console.error('[telegram] update failed', err instanceof Error ? err.message : err)
				);
				offset = update.update_id + 1;
				setState(OFFSET_KEY, String(offset));
			}
		} catch (err) {
			// 409 means another copy of the app is polling with the same token.
			const status = err instanceof TelegramError ? err.status : 0;
			if (status === 401) {
				console.error('[telegram] TELEGRAM_BOT_TOKEN was rejected; the bot is off until it is fixed');
				return;
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
		sendDueReminders().catch((err) => console.error('[telegram] reminders failed', err instanceof Error ? err.message : err));
	});
}
