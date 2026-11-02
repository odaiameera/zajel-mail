import cron from 'node-cron';
import { utcToWallClock } from '$lib/server/calendar/tz';
import { escapeHtml, sendMessage, telegramConfigured } from '$lib/server/telegram/bot';
import { getLink } from '$lib/server/telegram/store';
import { runJob, thrownStatus, type JobOutcome } from './runner';
import { claimNextDueJob, MAX_FAILURES, recordJobResult, type AgentJob } from './store';
import { JMAPAuthError } from '$lib/jmap/client';
import { markNeedsReauth } from '$lib/server/auth/accounts';
import { errorFields, logEvent } from '$lib/server/log';

/** Checks for due jobs once a minute and runs them one at a time. */

// A guard, not a schedule: each run moves its job's next time into the future.
const MAX_PER_TICK = 20;

let started = false;
let running = false;

async function notify(job: AgentJob, html: string): Promise<void> {
	const link = telegramConfigured() ? getLink(job.userId) : null;
	if (!link || link.paused) return;
	await sendMessage(link.chatId, html).catch((err) => logEvent('warn', 'jobs', 'notice_failed', { job: job.id, ...errorFields(err) }));
}

function clock(iso: string, timeZone: string): string {
	const wall = utcToWallClock(Date.parse(iso), timeZone);
	return `${String(wall.hour).padStart(2, '0')}:${String(wall.minute).padStart(2, '0')}`;
}

async function runOne(job: AgentJob): Promise<void> {
	const started = Date.now();
	let outcome: JobOutcome;
	if (job.runningSince) {
		// Its lease ran out with no result: the process stopped mid-run.
		outcome = { status: 'failed', result: 'Interrupted before it finished' };
	} else {
		try {
			outcome = await runJob(job, started);
		} catch (err) {
			// A stored password that stopped working flags the account, as the
			// other workers do; later runs then skip without trying Stalwart.
			if (err instanceof JMAPAuthError) markNeedsReauth(job.accountId);
			outcome = { status: thrownStatus(err), result: err instanceof Error ? err.message.slice(0, 200) : 'Failed' };
		}
	}
	const ranAt = job.runningSince ? Date.parse(job.runningSince) : started;
	const { disabled, givenUp, nextRunAt } = recordJobResult(job, outcome.status, outcome.result, ranAt);
	const ok = outcome.status === 'ok';
	// The result of a run that worked can quote mail, so only the others carry it.
	logEvent(ok || outcome.status === 'skipped' ? 'info' : 'warn', 'jobs', 'run', {
		job: job.id,
		kind: job.spec.kind,
		status: outcome.status,
		ok,
		ms: Date.now() - started,
		...(ok ? {} : { error: outcome.result, nextRunAt })
	});
	const title = `<b>${escapeHtml(job.title)}</b>`;
	if (disabled) {
		await notify(job, `${title} failed ${MAX_FAILURES} times in a row and was turned off: ${escapeHtml(outcome.result)}`);
	} else if (givenUp) {
		await notify(job, `${title} didn’t run and won’t be tried again: ${escapeHtml(outcome.result)}`);
	} else if (job.schedule.kind === 'once' && job.retries === 0 && nextRunAt && (outcome.status === 'failed' || outcome.status === 'retry')) {
		// A one-off's moment has come, so say so now rather than after five tries.
		await notify(job, `${title} didn’t run: ${escapeHtml(outcome.result)}. Trying again at ${clock(nextRunAt, job.timeZone)}.`);
	}
}

/**
 * One job at a time, each claimed just before it runs, so pausing,
 * switching a job off or deleting it stops whatever hasn't started yet.
 */
export async function runDueJobs(): Promise<void> {
	// One tick at a time: a long agent job can outlast a minute.
	if (running) return;
	running = true;
	try {
		for (let n = 0; n < MAX_PER_TICK; n += 1) {
			const job = claimNextDueJob();
			if (!job) break;
			await runOne(job);
		}
	} finally {
		running = false;
	}
}

export function startJobWorker(): void {
	if (started) return;
	started = true;
	cron.schedule('* * * * *', () => {
		runDueJobs().catch((err) => {
			console.error('[jobs] tick failed', err instanceof Error ? err.message : err);
			logEvent('error', 'jobs', 'tick_failed', errorFields(err));
		});
	});
}
