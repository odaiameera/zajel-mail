import cron from 'node-cron';
import { escapeHtml, sendMessage, telegramConfigured } from '$lib/server/telegram/bot';
import { getLink } from '$lib/server/telegram/store';
import { runJob } from './runner';
import { claimDueJobs, getJob, MAX_FAILURES, recordJobResult } from './store';

/** Checks for due jobs once a minute and runs them one at a time. */

let started = false;
let running = false;

async function tick(): Promise<void> {
	// One tick at a time: a long agent job can outlast a minute.
	if (running) return;
	running = true;
	try {
		for (const job of claimDueJobs()) {
			let outcome: { ok: boolean; result: string };
			try {
				outcome = await runJob(job);
			} catch (err) {
				outcome = { ok: false, result: err instanceof Error ? err.message.slice(0, 200) : 'Failed' };
			}
			recordJobResult(job.id, outcome.ok, outcome.result);
			// Tell the user when repeated failures switched a job off.
			if (!outcome.ok && job.failures + 1 >= MAX_FAILURES && !getJob(job.userId, job.id)?.enabled) {
				const link = telegramConfigured() ? getLink(job.userId) : null;
				if (link && !link.paused) {
					await sendMessage(link.chatId, `<b>${escapeHtml(job.title)}</b> failed ${MAX_FAILURES} times and was turned off: ${escapeHtml(outcome.result)}`).catch(() => {});
				}
			}
		}
	} finally {
		running = false;
	}
}

export function startJobWorker(): void {
	if (started) return;
	started = true;
	cron.schedule('* * * * *', () => {
		tick().catch((err) => console.error('[jobs] tick failed', err instanceof Error ? err.message : err));
	});
}
