import { randomUUID } from 'node:crypto';
import { getDb } from '../db/index';
import { nextRun, parseSchedule, type JobSchedule } from './schedule';
import { parseSpec, type JobSpec } from './specs';

/** Scheduled agent jobs and the pause-all switch. See migration 023. */

/** After this many failures in a row a job is switched off. */
export const MAX_FAILURES = 5;
/** A login can have this many jobs. */
export const MAX_JOBS = 20;

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
	lastResult: string | null;
	failures: number;
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
	last_result: string | null;
	failures: number;
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
		setEnabled: db.prepare(`UPDATE agent_jobs SET enabled = ?, failures = 0, next_run_at = ? WHERE id = ? AND user_id = ?`),
		remove: db.prepare(`DELETE FROM agent_jobs WHERE id = ? AND user_id = ?`),
		due: db.prepare(
			`SELECT j.* FROM agent_jobs j LEFT JOIN agent_settings s ON s.user_id = j.user_id
			 WHERE j.enabled = 1 AND j.next_run_at IS NOT NULL AND j.next_run_at <= ? AND COALESCE(s.jobs_paused, 0) = 0
			 ORDER BY j.next_run_at LIMIT 20`
		),
		// Compare-and-set on the run time, so two ticks can't both take a job.
		claim: db.prepare(
			`UPDATE agent_jobs SET next_run_at = ?, last_run_at = ? WHERE id = ? AND next_run_at = ? AND enabled = 1`
		),
		result: db.prepare(
			`UPDATE agent_jobs SET last_result = @result,
			   failures = CASE WHEN @ok THEN 0 ELSE failures + 1 END,
			   enabled = CASE WHEN @ok OR failures + 1 < @max THEN enabled ELSE 0 END
			 WHERE id = @id`
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
		lastResult: row.last_result,
		failures: row.failures
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

/** Turning a job back on starts it from its next time, not a backlog. */
export function setJobEnabled(userId: string, id: string, enabled: boolean, nowMs = Date.now()): boolean {
	const job = getJob(userId, id);
	if (!job) return false;
	const next = enabled ? nextRun(job.schedule, job.timeZone, nowMs) : job.nextRunAt ? Date.parse(job.nextRunAt) : null;
	return stmts().setEnabled.run(enabled ? 1 : 0, iso(next), id, userId).changes === 1;
}

export function deleteJob(userId: string, id: string): boolean {
	return stmts().remove.run(id, userId).changes === 1;
}

/**
 * Take the jobs that are due, each moved on to its next time first, so a
 * slow or failing run is never started twice and never queues up.
 */
export function claimDueJobs(nowMs = Date.now()): AgentJob[] {
	const claimed: AgentJob[] = [];
	for (const row of stmts().due.all(iso(nowMs)) as JobRow[]) {
		const job = toJob(row);
		if (!job) continue;
		const next = nextRun(job.schedule, job.timeZone, nowMs);
		if (stmts().claim.run(iso(next), iso(nowMs), row.id, row.next_run_at).changes === 1) claimed.push(job);
	}
	return claimed;
}

export function recordJobResult(id: string, ok: boolean, result: string): void {
	stmts().result.run({ id, ok: ok ? 1 : 0, result: result.slice(0, 500), max: MAX_FAILURES });
}

export function jobsPaused(userId: string): boolean {
	return (stmts().pausedGet.get(userId) as { jobs_paused: number } | undefined)?.jobs_paused === 1;
}

export function setJobsPaused(userId: string, paused: boolean): void {
	stmts().pausedSet.run(userId, paused ? 1 : 0);
}
