import { randomUUID } from 'node:crypto';
import { getDb } from '../db/index';
import { logEvent } from '$lib/server/log';
import { nextRun, parseSchedule, type JobSchedule } from './schedule';
import { parseSpec, type JobSpec } from './specs';

/** Scheduled agent jobs and the pause-all switch. See migrations 023 and 025. */

/** After this many failures in a row a job is switched off. */
export const MAX_FAILURES = 5;
// Tries before a one-off is given up: about seven hours with the backoff.
const ONE_OFF_TRIES = 10;
/** A login can have this many jobs. */
export const MAX_JOBS = 20;
/**
 * A claimed job isn't due again for this long. Its result sets the real next
 * time; if the process stops mid-run, the job comes round again after this.
 * Well past the agent's turn budget.
 */
export const LEASE_MS = 15 * 60_000;
/** Retry delays: 5 minutes, doubling, at most an hour. */
const RETRY_BASE_MS = 5 * 60_000;
const RETRY_MAX_MS = 60 * 60_000;
/** On unpause, a job overdue by more than this has gone stale. */
const STALE_MS = 15 * 60_000;

/**
 * How a run went:
 * - ok: it worked;
 * - failed: it went wrong, and counts toward switching the job off;
 * - retry: an outage upstream (Claude, the mail server, Telegram);
 * - skipped: it couldn't start (the account needs its password, Telegram is off).
 * Neither of the last two counts against the job, and both try again later.
 */
export type JobStatus = 'ok' | 'failed' | 'retry' | 'skipped';

export interface AgentJob {
	id: string;
	userId: string;
	accountId: string;
	title: string;
	spec: JobSpec;
	schedule: JobSchedule;
	timeZone: string;
	enabled: boolean;
	nextRunAt: string | null;
	lastRunAt: string | null;
	/** Start of the last run that worked: where the next digest picks up. */
	lastOkAt: string | null;
	lastResult: string | null;
	failures: number;
	retries: number;
	runningSince: string | null;
}

interface JobRow {
	id: string;
	user_id: string;
	account_id: string;
	title: string;
	spec_json: string;
	schedule_json: string;
	time_zone: string;
	enabled: number;
	next_run_at: string | null;
	last_run_at: string | null;
	last_ok_at: string | null;
	last_result: string | null;
	failures: number;
	retries: number;
	running_since: string | null;
}

let _stmts: ReturnType<typeof prepareStmts> | null = null;
function prepareStmts() {
	const db = getDb();
	return {
		insert: db.prepare(
			`INSERT INTO agent_jobs (id, user_id, account_id, title, spec_json, schedule_json, time_zone, next_run_at)
			 VALUES (@id, @userId, @accountId, @title, @spec, @schedule, @timeZone, @nextRunAt)`
		),
		count: db.prepare(`SELECT COUNT(*) AS n FROM agent_jobs WHERE user_id = ?`),
		list: db.prepare(`SELECT * FROM agent_jobs WHERE user_id = ? ORDER BY created_at`),
		get: db.prepare(`SELECT * FROM agent_jobs WHERE id = ? AND user_id = ?`),
		counters: db.prepare(`SELECT enabled, failures, retries FROM agent_jobs WHERE id = ?`),
		setEnabled: db.prepare(
			`UPDATE agent_jobs SET enabled = ?, failures = 0, retries = 0, running_since = NULL, next_run_at = ? WHERE id = ? AND user_id = ?`
		),
		remove: db.prepare(`DELETE FROM agent_jobs WHERE id = ? AND user_id = ?`),
		due: db.prepare(
			`SELECT j.* FROM agent_jobs j LEFT JOIN agent_settings s ON s.user_id = j.user_id
			 WHERE j.enabled = 1 AND j.next_run_at IS NOT NULL AND j.next_run_at <= ? AND COALESCE(s.jobs_paused, 0) = 0
			 ORDER BY j.next_run_at LIMIT 20`
		),
		// Compare-and-set on the run time, so two ticks can't both take a job.
		claim: db.prepare(
			`UPDATE agent_jobs SET next_run_at = @lease, running_since = @now
			 WHERE id = @id AND next_run_at = @due AND enabled = 1`
		),
		result: db.prepare(
			`UPDATE agent_jobs SET last_result = @result, last_run_at = @ranAt,
			   last_ok_at = CASE WHEN @ok THEN @ranAt ELSE last_ok_at END,
			   failures = @failures, retries = CASE WHEN @ok THEN 0 ELSE retries + 1 END,
			   enabled = CASE WHEN @disable THEN 0 ELSE enabled END,
			   next_run_at = @next, running_since = NULL
			 WHERE id = @id`
		),
		reschedule: db.prepare(`UPDATE agent_jobs SET next_run_at = ?, retries = 0, running_since = NULL WHERE id = ?`),
		missed: db.prepare(
			`UPDATE agent_jobs SET last_run_at = next_run_at, next_run_at = NULL, retries = 0, running_since = NULL,
			   last_result = 'Missed while paused' WHERE id = ?`
		),
		pausedGet: db.prepare(`SELECT jobs_paused FROM agent_settings WHERE user_id = ?`),
		pausedSet: db.prepare(
			`INSERT INTO agent_settings (user_id, jobs_paused) VALUES (?, ?)
			 ON CONFLICT (user_id) DO UPDATE SET jobs_paused = excluded.jobs_paused`
		)
	};
}
function stmts() {
	return (_stmts ??= prepareStmts());
}

function toJob(row: JobRow): AgentJob | null {
	const spec = parseSpec(JSON.parse(row.spec_json));
	const schedule = parseSchedule(JSON.parse(row.schedule_json));
	if (!spec || !schedule) return null;
	return {
		id: row.id,
		userId: row.user_id,
		accountId: row.account_id,
		title: row.title,
		spec,
		schedule,
		timeZone: row.time_zone,
		enabled: row.enabled === 1,
		nextRunAt: row.next_run_at,
		lastRunAt: row.last_run_at,
		lastOkAt: row.last_ok_at,
		lastResult: row.last_result,
		failures: row.failures,
		retries: row.retries,
		runningSince: row.running_since
	};
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

export function createJob(input: {
	userId: string;
	accountId: string;
	title: string;
	spec: JobSpec;
	schedule: JobSchedule;
	timeZone: string;
}, nowMs = Date.now()): AgentJob | { error: string } {
	if ((stmts().count.get(input.userId) as { n: number }).n >= MAX_JOBS) return { error: `There can be at most ${MAX_JOBS} jobs` };
	const next = nextRun(input.schedule, input.timeZone, nowMs);
	if (next === null) return { error: 'That time has already passed' };
	const id = randomUUID();
	stmts().insert.run({
		id,
		userId: input.userId,
		accountId: input.accountId,
		title: input.title.slice(0, 120),
		spec: JSON.stringify(input.spec),
		schedule: JSON.stringify(input.schedule),
		timeZone: input.timeZone,
		nextRunAt: iso(next)
	});
	return getJob(input.userId, id)!;
}

export function listJobs(userId: string): AgentJob[] {
	return (stmts().list.all(userId) as JobRow[]).map(toJob).filter((j): j is AgentJob => j !== null);
}

export function getJob(userId: string, id: string): AgentJob | null {
	const row = stmts().get.get(id, userId) as JobRow | undefined;
	return row ? toJob(row) : null;
}

/**
 * Turning a job back on starts it from its next time, not a backlog. A
 * one-off that never worked has no next time, so it runs now instead.
 */
export function setJobEnabled(userId: string, id: string, enabled: boolean, nowMs = Date.now()): boolean {
	const job = getJob(userId, id);
	if (!job) return false;
	let next = job.nextRunAt ? Date.parse(job.nextRunAt) : null;
	if (enabled) next = nextRun(job.schedule, job.timeZone, nowMs) ?? (job.schedule.kind === 'once' && !job.lastOkAt ? nowMs : null);
	return stmts().setEnabled.run(enabled ? 1 : 0, iso(next), id, userId).changes === 1;
}

export function deleteJob(userId: string, id: string): boolean {
	return stmts().remove.run(id, userId).changes === 1;
}

/**
 * Take the next due job, right before it runs, so pausing, switching a job
 * off or deleting it stops everything that hasn't started. The claim is a
 * lease: the result sets the real next time. A job that comes back with
 * `runningSince` still set had its last run cut short.
 */
export function claimNextDueJob(nowMs = Date.now()): AgentJob | null {
	for (const row of stmts().due.all(iso(nowMs)) as JobRow[]) {
		const job = toJob(row);
		if (!job) continue;
		if (stmts().claim.run({ lease: iso(nowMs + LEASE_MS), now: iso(nowMs), id: row.id, due: row.next_run_at }).changes === 1) return job;
	}
	return null;
}

/** 5 minutes after the first failure, then 10, 20, 40, and hourly after that. */
function retryDelay(retries: number): number {
	return Math.min(RETRY_BASE_MS * 2 ** retries, RETRY_MAX_MS);
}

/**
 * Record a run that started at `ranAtMs`. Only a run that worked moves the
 * digest window on; anything else is retried after a growing delay, but
 * never later than the job's next regular time.
 */
export function recordJobResult(
	job: AgentJob,
	status: JobStatus,
	result: string,
	ranAtMs: number,
	nowMs = Date.now()
): { disabled: boolean; givenUp: boolean; nextRunAt: string | null } {
	// Read fresh: the job may have been switched off or deleted while it ran.
	const row = stmts().counters.get(job.id) as Pick<JobRow, 'enabled' | 'failures' | 'retries'> | undefined;
	if (!row) return { disabled: false, givenUp: false, nextRunAt: null };
	const ok = status === 'ok';
	const failures = ok ? 0 : status === 'failed' ? row.failures + 1 : row.failures;
	const disable = status === 'failed' && row.enabled === 1 && failures >= MAX_FAILURES;
	const due = nextRun(job.schedule, job.timeZone, nowMs);
	const retryAt = nowMs + retryDelay(row.retries);
	// A one-off can't keep trying for days and then run with no warning:
	// after ONE_OFF_TRIES it is given up, like a one-off missed while paused.
	const givenUp = !ok && !disable && due === null && row.retries + 1 >= ONE_OFF_TRIES;
	let next = ok || disable || givenUp ? due : due === null ? retryAt : Math.min(due, retryAt);
	// A run that only worked after retries can land just before its next
	// regular time; then that one is skipped rather than run twice in a row.
	if (ok && row.retries > 0 && due !== null) {
		const after = nextRun(job.schedule, job.timeZone, due);
		if (after !== null && due - nowMs < (after - due) / 2) next = after;
	}
	stmts().result.run({
		id: job.id,
		ok: ok ? 1 : 0,
		result: (givenUp ? `Gave up: ${result}` : result).slice(0, 500),
		ranAt: iso(ranAtMs),
		failures,
		disable: disable ? 1 : 0,
		next: iso(next)
	});
	if (disable) logEvent('warn', 'jobs', 'disabled', { job: job.id, kind: job.spec.kind, failures });
	if (givenUp) logEvent('warn', 'jobs', 'gave_up', { job: job.id, kind: job.spec.kind, tries: row.retries + 1 });
	// Switched off while it ran: there is no next time to tell anyone about.
	return { disabled: disable, givenUp, nextRunAt: row.enabled === 1 ? iso(next) : null };
}

export function jobsPaused(userId: string): boolean {
	return (stmts().pausedGet.get(userId) as { jobs_paused: number } | undefined)?.jobs_paused === 1;
}

/**
 * Unpausing doesn't fire everything that fell due meanwhile: a recurring job
 * waits for its next time, and a one-off whose time has gone is marked
 * missed rather than run late.
 */
export function setJobsPaused(userId: string, paused: boolean, nowMs = Date.now()): void {
	getDb().transaction(() => {
		const was = jobsPaused(userId);
		stmts().pausedSet.run(userId, paused ? 1 : 0);
		if (paused || !was) return;
		for (const job of listJobs(userId)) {
			if (!job.enabled || !job.nextRunAt || Date.parse(job.nextRunAt) > nowMs - STALE_MS) continue;
			const next = nextRun(job.schedule, job.timeZone, nowMs);
			if (next === null) {
				stmts().missed.run(job.id);
				logEvent('info', 'jobs', 'missed', { job: job.id, kind: job.spec.kind });
			} else {
				stmts().reschedule.run(iso(next), job.id);
			}
		}
	})();
}
