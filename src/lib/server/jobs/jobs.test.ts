import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'ameera-jobs-')), 'test.db');

const mocks = vi.hoisted(() => ({
	searchEmails: vi.fn(),
	updateEmailMailboxes: vi.fn(),
	sendMessage: vi.fn(async () => ({})),
	runChat: vi.fn(async (_input: { messages: { content: string }[] }) => 'Dana needs the contract today.'),
	link: { chatId: '555', paused: false } as { chatId: string; paused: boolean } | null
}));
vi.mock('$lib/jmap/auth', () => ({ createClient: () => ({}) }));
vi.mock('$lib/jmap/email', () => ({
	searchEmails: mocks.searchEmails,
	updateEmailMailboxes: mocks.updateEmailMailboxes,
	moveEmails: vi.fn()
}));
vi.mock('$lib/jmap/mailbox', () => ({
	getMailboxes: async () => [{ id: 'IN', name: 'Inbox', role: 'inbox', parentId: null }],
	ensureArchiveMailbox: async () => 'AR'
}));
vi.mock('$lib/server/auth/accounts', () => ({
	getAccount: (id: string) => ({ id, user_id: 'user-1', email: 'me@example.test', needs_reauth: 0 }),
	authStateForAccount: () => ({ accountId: 'jmap' })
}));
vi.mock('$lib/server/ai/chat', () => ({ runChat: mocks.runChat }));
vi.mock('$lib/server/agent/runtime', () => ({ runAgentTurn: vi.fn() }));
vi.mock('$lib/server/telegram/bot', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/telegram/bot')>()),
	telegramConfigured: () => true,
	sendMessage: mocks.sendMessage
}));
vi.mock('$lib/server/telegram/store', () => ({ getLink: () => mocks.link }));

import { getDb } from '../db/index';
import { runMigrations } from '../db/migrate';
import { describeSchedule, nextRun } from './schedule';
import { claimDueJobs, createJob, getJob, recordJobResult, setJobsPaused, type AgentJob } from './store';
import { runJob } from './runner';
import { JOB_TOOLS } from '$lib/server/agent/job-tools';
import { decidePendingAction } from '$lib/server/agent/actions';
import type { ToolContext } from '$lib/server/agent/tools';
import { POST as decide } from '../../../routes/api/ai/actions/[id]/+server';

const ZONE = 'Asia/Amman'; // UTC+3
const SUNDAY_9AM_UTC = Date.parse('2026-11-01T09:00:00Z'); // 12:00 in Amman

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
	mocks.link = { chatId: '555', paused: false };
	getDb().exec('DELETE FROM agent_jobs; DELETE FROM agent_settings; DELETE FROM agent_actions;');
	setJobsPaused('user-1', false);
});

describe('schedules', () => {
	it('finds the next run in the user’s own time zone', () => {
		const at = (iso: string) => Date.parse(iso);
		expect(nextRun({ kind: 'daily', at: '08:00' }, ZONE, SUNDAY_9AM_UTC)).toBe(at('2026-11-02T05:00:00Z'));
		expect(nextRun({ kind: 'daily', at: '13:00' }, ZONE, SUNDAY_9AM_UTC)).toBe(at('2026-11-01T10:00:00Z'));
		// Sunday → the next weekday is Monday.
		expect(nextRun({ kind: 'weekdays', at: '11:00' }, ZONE, SUNDAY_9AM_UTC)).toBe(at('2026-11-02T08:00:00Z'));
		expect(nextRun({ kind: 'weekly', at: '09:30', day: 5 }, ZONE, SUNDAY_9AM_UTC)).toBe(at('2026-11-06T06:30:00Z'));
		expect(nextRun({ kind: 'hourly' }, ZONE, SUNDAY_9AM_UTC)).toBe(at('2026-11-01T10:00:00Z'));
		expect(nextRun({ kind: 'once', at: '2026-11-01T10:00' }, ZONE, SUNDAY_9AM_UTC)).toBeNull();
		expect(nextRun({ kind: 'once', at: '2026-11-01T13:00' }, ZONE, SUNDAY_9AM_UTC)).toBe(at('2026-11-01T10:00:00Z'));
		expect(describeSchedule({ kind: 'weekdays', at: '08:00' }, ZONE)).toBe('Weekdays at 08:00 (Asia/Amman)');
	});
});

describe('the job store', () => {
	const digest = (title = 'Morning digest'): AgentJob => {
		const job = createJob(
			{ userId: 'user-1', accountId: 'acct-1', title, spec: { kind: 'digest', scope: 'important_unread' }, schedule: { kind: 'daily', at: '08:00' }, timeZone: ZONE },
			SUNDAY_9AM_UTC
		);
		if ('error' in job) throw new Error(job.error);
		return job;
	};

	it('hands a due job to one tick only, and moves it on to its next time', () => {
		const job = digest();
		const due = Date.parse(job.nextRunAt!) + 1000;
		expect(claimDueJobs(due).map((j) => j.id)).toEqual([job.id]);
		expect(claimDueJobs(due)).toEqual([]);
		expect(Date.parse(getJob('user-1', job.id)!.nextRunAt!)).toBe(Date.parse('2026-11-03T05:00:00Z'));
	});

	it('skips everything while paused', () => {
		const job = digest();
		setJobsPaused('user-1', true);
		expect(claimDueJobs(Date.parse(job.nextRunAt!) + 1000)).toEqual([]);
	});

	it('switches a job off after five failures in a row', () => {
		const job = digest();
		for (let i = 0; i < 4; i++) recordJobResult(job.id, false, 'boom');
		expect(getJob('user-1', job.id)!.enabled).toBe(true);
		recordJobResult(job.id, false, 'boom');
		expect(getJob('user-1', job.id)).toMatchObject({ enabled: false, failures: 5, lastResult: 'boom' });
	});
});

describe('proposing a job', () => {
	const tool = JOB_TOOLS.find((t) => t.name === 'schedule_job')!;
	const ctx = (source: ToolContext['source']): ToolContext => ({
		auth: { accountId: 'jmap' } as ToolContext['auth'],
		client: {} as ToolContext['client'],
		userId: 'user-1',
		userEmail: 'me@example.test',
		accountRowId: 'acct-1',
		conversationId: null,
		source,
		timeZone: ZONE,
		mailboxes: async () => []
	});
	const input = {
		title: 'Promotions sweep',
		what: { kind: 'tidy', scope: null, tabs: ['promotions'], older_than_hours: 24, action: 'mark_read', instructions: null },
		when: { kind: 'daily', at: '21:00', day: null }
	};

	it('only from a chat, and only as a card that a re-checked confirm turns into a job', async () => {
		expect((await tool.run(ctx('job'), input)).isError).toBe(true);

		const { pending } = await tool.run(ctx('chat'), input);
		expect(pending?.kind).toBe('create_job');

		const call = (verifiedAt: number | null) =>
			decide({
				locals: { user: { id: 'user-1' }, sessionVerifiedAt: verifiedAt },
				params: { id: pending!.id },
				request: new Request('http://localhost', { method: 'POST', body: JSON.stringify({ decision: 'confirm' }) })
			} as unknown as Parameters<typeof decide>[0]);
		const refused = await call(null);
		expect(refused.status).toBe(403);
		expect(await refused.json()).toMatchObject({ stepUp: true });
		expect(getDb().prepare('SELECT COUNT(*) AS n FROM agent_jobs').get()).toEqual({ n: 0 });

		expect((await call(Date.now())).status).toBe(200);
		expect(getDb().prepare('SELECT title FROM agent_jobs').all()).toEqual([{ title: 'Promotions sweep' }]);
	});

	it('cancelling sends nothing to the scheduler', async () => {
		const { pending } = await tool.run(ctx('chat'), input);
		await decidePendingAction('user-1', pending!.id, 'cancel');
		expect(getDb().prepare('SELECT COUNT(*) AS n FROM agent_jobs').get()).toEqual({ n: 0 });
	});
});

describe('running a job', () => {
	it('tidies only old mail in the chosen tabs, never starred mail', async () => {
		mocks.searchEmails.mockResolvedValue({ emails: [{ id: 'p1' }, { id: 'p2' }], total: 2 });
		const job = createJob(
			{ userId: 'user-1', accountId: 'acct-1', title: 'Sweep', spec: { kind: 'tidy', tabs: ['promotions'], olderThanHours: 24, action: 'mark_read' }, schedule: { kind: 'daily', at: '21:00' }, timeZone: ZONE },
			SUNDAY_9AM_UTC
		) as AgentJob;
		const result = await runJob(job, SUNDAY_9AM_UTC);
		expect(result).toEqual({ ok: true, result: 'Marked read 2' });
		const filter = mocks.searchEmails.mock.calls[0][2];
		expect(filter.conditions).toEqual(
			expect.arrayContaining([
				{ inMailbox: 'IN' },
				{ before: '2026-10-31T09:00:00.000Z' },
				{ operator: 'OR', conditions: [{ hasKeyword: '$cat_promotions' }] },
				{ notKeyword: '$flagged' },
				{ notKeyword: '$seen' }
			])
		);
		expect(mocks.updateEmailMailboxes).toHaveBeenCalledWith({}, 'jmap', {
			p1: { keywords: { $seen: true } },
			p2: { keywords: { $seen: true } }
		});
	});

	it('sends a digest written by the writer model, and fails when Telegram is off', async () => {
		mocks.searchEmails.mockResolvedValue({
			emails: [
				{ id: 'a', keywords: {}, from: [{ name: 'Dana', email: 'd@example.test' }], subject: 'Contract' },
				{ id: 'b', keywords: { $cat_promotions: true }, from: [{ name: 'Shop', email: 's@example.test' }], subject: 'Sale' }
			],
			total: 2
		});
		const job = createJob(
			{ userId: 'user-1', accountId: 'acct-1', title: 'Morning', spec: { kind: 'digest', scope: 'important_unread' }, schedule: { kind: 'daily', at: '08:00' }, timeZone: ZONE },
			SUNDAY_9AM_UTC
		) as AgentJob;

		expect(await runJob(job, SUNDAY_9AM_UTC)).toEqual({ ok: true, result: 'Sent a digest of 1' });
		expect(mocks.runChat.mock.calls[0][0].messages[0].content).toBe('- Dana: Contract');
		expect(mocks.sendMessage).toHaveBeenCalledWith('555', '<b>Morning</b>\nDana needs the contract today.');

		mocks.link = null;
		expect((await runJob(job, SUNDAY_9AM_UTC)).ok).toBe(false);
	});
});
