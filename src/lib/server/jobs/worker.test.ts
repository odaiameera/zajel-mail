import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'ameera-job-worker-')), 'test.db');

const mocks = vi.hoisted(() => ({
	runJob: vi.fn(),
	sendMessage: vi.fn(async (..._args: unknown[]) => ({})),
	link: { chatId: '555', paused: false } as { chatId: string; paused: boolean } | null
}));
vi.mock('node-cron', () => ({ default: { schedule: vi.fn() } }));
vi.mock('./runner', async (importOriginal) => ({
	...(await importOriginal<typeof import('./runner')>()),
	runJob: mocks.runJob
}));
vi.mock('$lib/server/telegram/bot', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/telegram/bot')>()),
	telegramConfigured: () => true,
	sendMessage: mocks.sendMessage
}));
vi.mock('$lib/server/telegram/store', () => ({ getLink: () => mocks.link }));

import { getDb } from '../db/index';
import { runMigrations } from '../db/migrate';
import { MailAssistantError } from '$lib/server/ai/mail-assistant';
import { claimNextDueJob, createJob, deleteJob, getJob, LEASE_MS, setJobEnabled, setJobsPaused, type AgentJob } from './store';
import type { JobSchedule } from './schedule';
import { runDueJobs } from './worker';

const ZONE = 'Asia/Amman'; // UTC+3
const SUNDAY_9AM_UTC = Date.parse('2026-11-01T09:00:00Z');
const MONDAY_8AM_AMMAN = Date.parse('2026-11-02T05:00:00Z');
const MIN = 60_000;

beforeAll(() => {
	runMigrations();
	getDb().prepare(`INSERT INTO app_user (id, email, password_hash) VALUES ('user-1', 'u@example.test', 'x')`).run();
	getDb()
		.prepare(
			`INSERT INTO mail_accounts (id, user_id, email, server_url, jmap_account_id, secret_enc)
			 VALUES ('acct-1', 'user-1', 'me@example.test', 'https://mail.example', 'jmap', 'x')`
		)
		.run();
});

beforeEach(() => {
	vi.clearAllMocks();
	vi.useFakeTimers({ toFake: ['Date'] });
	mocks.link = { chatId: '555', paused: false };
	mocks.runJob.mockResolvedValue({ status: 'ok', result: 'Done' });
	getDb().exec('DELETE FROM agent_jobs; DELETE FROM agent_settings;');
});

afterEach(() => {
	vi.useRealTimers();
});

function makeJob(title: string, schedule: JobSchedule = { kind: 'daily', at: '08:00' }): AgentJob {
	const job = createJob(
		{ userId: 'user-1', accountId: 'acct-1', title, spec: { kind: 'agent', instructions: 'Check the bank' }, schedule, timeZone: ZONE },
		SUNDAY_9AM_UTC
	);
	if ('error' in job) throw new Error(job.error);
	return job;
}

const fresh = (job: AgentJob) => getJob('user-1', job.id)!;

describe('the job worker', () => {
	it.each([
		['pausing everything', (_id: string) => setJobsPaused('user-1', true)],
		['switching the job off', (id: string) => setJobEnabled('user-1', id, false)],
		['deleting the job', (id: string) => deleteJob('user-1', id)]
	])('stops a job that hasn’t started yet on %s', async (_name, stop) => {
		const a = makeJob('A');
		const b = makeJob('B');
		vi.setSystemTime(MONDAY_8AM_AMMAN + 30_000);
		mocks.runJob.mockImplementationOnce(async (job: AgentJob) => {
			stop(job.id === a.id ? b.id : a.id);
			return { status: 'ok', result: 'Done' };
		});
		await runDueJobs();
		expect(mocks.runJob).toHaveBeenCalledTimes(1);
	});

	it('retries an outage soon, without counting it or messaging about a recurring job', async () => {
		const job = makeJob('Bank check');
		const now = MONDAY_8AM_AMMAN + 30_000;
		vi.setSystemTime(now);
		mocks.runJob.mockRejectedValueOnce(new MailAssistantError('The AI service is rate limiting this account — wait a moment and try again', 502, true));
		await runDueJobs();
		expect(fresh(job)).toMatchObject({
			enabled: true,
			failures: 0,
			retries: 1,
			nextRunAt: new Date(now + 5 * MIN).toISOString(),
			lastResult: 'The AI service is rate limiting this account — wait a moment and try again'
		});
		expect(mocks.sendMessage).not.toHaveBeenCalled();
	});

	it('says so on a one-off’s first failure, and turns a job off with a notice after five', async () => {
		const job = makeJob('Check reply', { kind: 'once', at: '2026-11-01T17:00' });
		mocks.runJob.mockRejectedValue(new MailAssistantError('The AI service rejected its API key', 502));
		vi.setSystemTime(Date.parse('2026-11-01T14:00:30Z'));
		await runDueJobs();
		expect(mocks.sendMessage).toHaveBeenCalledWith(
			'555',
			'<b>Check reply</b> didn’t run: The AI service rejected its API key. Trying again at 17:05.'
		);

		for (let i = 0; i < 4; i++) {
			vi.setSystemTime(Date.parse(fresh(job).nextRunAt!) + 1000);
			await runDueJobs();
		}
		expect(fresh(job)).toMatchObject({ enabled: false, failures: 5 });
		expect(mocks.runJob).toHaveBeenCalledTimes(5);
		expect(mocks.sendMessage).toHaveBeenCalledTimes(2);
		expect(mocks.sendMessage).toHaveBeenLastCalledWith(
			'555',
			'<b>Check reply</b> failed 5 times in a row and was turned off: The AI service rejected its API key'
		);
	});

	it('records a run cut short by a restart, and runs the job again', async () => {
		const job = makeJob('Bank check');
		const claimedAt = MONDAY_8AM_AMMAN + 30_000;
		vi.setSystemTime(claimedAt);
		// The process stops right after the claim.
		claimNextDueJob();
		const back = claimedAt + LEASE_MS + MIN;
		vi.setSystemTime(back);
		await runDueJobs();
		expect(mocks.runJob).not.toHaveBeenCalled();
		expect(fresh(job)).toMatchObject({
			lastResult: 'Interrupted before it finished',
			lastRunAt: new Date(claimedAt).toISOString(),
			failures: 1,
			runningSince: null,
			nextRunAt: new Date(back + 5 * MIN).toISOString()
		});

		vi.setSystemTime(back + 5 * MIN);
		await runDueJobs();
		expect(mocks.runJob).toHaveBeenCalledTimes(1);
		expect(fresh(job)).toMatchObject({ failures: 0, lastResult: 'Done', nextRunAt: '2026-11-03T05:00:00.000Z' });
	});
});
