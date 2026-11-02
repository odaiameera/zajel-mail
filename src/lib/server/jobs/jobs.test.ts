import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'ameera-jobs-')), 'test.db');

const mocks = vi.hoisted(() => ({
	searchEmails: vi.fn(),
	updateEmailMailboxes: vi.fn(),
	getMailboxes: vi.fn(async () => [{ id: 'IN', name: 'Inbox', role: 'inbox', parentId: null }]),
	sendMessage: vi.fn(async (..._args: unknown[]) => ({})),
	runChat: vi.fn(async (_input: { messages: { content: string }[] }) => 'Dana needs the contract today.'),
	runAgentTurn: vi.fn(),
	logEvent: vi.fn(),
	link: { chatId: '555', paused: false } as { chatId: string; paused: boolean } | null,
	needsReauth: 0
}));
vi.mock('$lib/jmap/auth', () => ({ createClient: () => ({}) }));
vi.mock('$lib/jmap/email', () => ({
	searchEmails: mocks.searchEmails,
	updateEmailMailboxes: mocks.updateEmailMailboxes,
	moveEmails: vi.fn()
}));
vi.mock('$lib/jmap/mailbox', () => ({
	getMailboxes: mocks.getMailboxes,
	ensureArchiveMailbox: async () => 'AR'
}));
vi.mock('$lib/server/auth/accounts', () => ({
	getAccount: (id: string) => ({ id, user_id: 'user-1', email: 'me@example.test', needs_reauth: mocks.needsReauth }),
	authStateForAccount: () => ({ accountId: 'jmap' })
}));
vi.mock('$lib/server/ai/chat', () => ({ runChat: mocks.runChat }));
vi.mock('$lib/server/agent/runtime', () => ({ runAgentTurn: mocks.runAgentTurn }));
vi.mock('$lib/server/telegram/bot', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/telegram/bot')>()),
	telegramConfigured: () => true,
	sendMessage: mocks.sendMessage
}));
vi.mock('$lib/server/telegram/store', () => ({ getLink: () => mocks.link }));
vi.mock('$lib/server/log', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/log')>()),
	logEvent: mocks.logEvent
}));

import { getDb } from '../db/index';
import { runMigrations } from '../db/migrate';
import { describeSchedule, nextRun, parseSchedule } from './schedule';
import {
	claimNextDueJob,
	createJob,
	getJob,
	LEASE_MS,
	recordJobResult,
	setJobEnabled,
	setJobsPaused,
	type AgentJob
} from './store';
import { runJob, thrownStatus } from './runner';
import { JOB_TOOLS } from '$lib/server/agent/job-tools';
import { decidePendingAction } from '$lib/server/agent/actions';
import type { ToolContext } from '$lib/server/agent/tools';
import { newTurnBudget } from '$lib/server/agent/budget';
import { MailAssistantError } from '$lib/server/ai/mail-assistant';
import { TelegramError } from '$lib/server/telegram/bot';
import { JMAPAuthError, JMAPError, JMAPMethodError } from '$lib/jmap/client';
import { categoryCondition } from '$lib/types/categories';
import { POST as decide } from '../../../routes/api/ai/actions/[id]/+server';

const ZONE = 'Asia/Amman'; // UTC+3
const SUNDAY_9AM_UTC = Date.parse('2026-11-01T09:00:00Z'); // 12:00 in Amman
const MIN = 60_000;
const at = (iso: string) => Date.parse(iso);

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
	mocks.needsReauth = 0;
	getDb().exec('DELETE FROM agent_jobs; DELETE FROM agent_settings; DELETE FROM agent_actions;');
	setJobsPaused('user-1', false);
});

function makeJob(over: Partial<Parameters<typeof createJob>[0]> = {}): AgentJob {
	const job = createJob(
		{
			userId: 'user-1',
			accountId: 'acct-1',
			title: 'Morning digest',
			spec: { kind: 'digest', scope: 'important_unread' },
			schedule: { kind: 'daily', at: '08:00' },
			timeZone: ZONE,
			...over
		},
		SUNDAY_9AM_UTC
	);
	if ('error' in job) throw new Error(job.error);
	return job;
}

describe('schedules', () => {
	it('finds the next run in the user’s own time zone', () => {
		expect(nextRun({ kind: 'daily', at: '08:00' }, ZONE, SUNDAY_9AM_UTC)).toBe(at('2026-11-02T05:00:00Z'));
		expect(nextRun({ kind: 'daily', at: '13:00' }, ZONE, SUNDAY_9AM_UTC)).toBe(at('2026-11-01T10:00:00Z'));
		// 'weekdays' is Monday to Friday: from Sunday, the next one is Monday.
		expect(nextRun({ kind: 'weekdays', at: '11:00' }, ZONE, SUNDAY_9AM_UTC)).toBe(at('2026-11-02T08:00:00Z'));
		expect(nextRun({ kind: 'weekly', at: '09:30', day: 5 }, ZONE, SUNDAY_9AM_UTC)).toBe(at('2026-11-06T06:30:00Z'));
		expect(nextRun({ kind: 'hourly' }, ZONE, SUNDAY_9AM_UTC)).toBe(at('2026-11-01T10:00:00Z'));
		expect(nextRun({ kind: 'once', at: '2026-11-01T10:00' }, ZONE, SUNDAY_9AM_UTC)).toBeNull();
		expect(nextRun({ kind: 'once', at: '2026-11-01T13:00' }, ZONE, SUNDAY_9AM_UTC)).toBe(at('2026-11-01T10:00:00Z'));
		expect(describeSchedule({ kind: 'weekdays', at: '08:00' }, ZONE)).toBe('Mon–Fri at 08:00 (Asia/Amman)');
	});

	it('runs on the days the user works: a Sunday-to-Thursday week skips Friday and Saturday', () => {
		const week = parseSchedule({ kind: 'days', at: '08:00', days: [4, 0, 1, 2, 3, 3] });
		expect(week).toEqual({ kind: 'days', at: '08:00', days: [0, 1, 2, 3, 4] });
		// Sunday noon → Monday 08:00; Thursday noon → Sunday 08:00.
		expect(nextRun(week!, ZONE, SUNDAY_9AM_UTC)).toBe(at('2026-11-02T05:00:00Z'));
		expect(nextRun(week!, ZONE, at('2026-11-05T09:00:00Z'))).toBe(at('2026-11-08T05:00:00Z'));
		expect(describeSchedule(week!, ZONE)).toBe('Sun–Thu at 08:00 (Asia/Amman)');
	});

	it('names the days on the card, and refuses days that don’t exist', () => {
		const describe = (days: number[]) => describeSchedule({ kind: 'days', at: '09:00', days }, 'UTC');
		expect(describe([0, 1, 2, 3, 6])).toBe('Sat–Wed at 09:00 (UTC)');
		expect(describe([5, 6])).toBe('Fri, Sat at 09:00 (UTC)');
		expect(describe([1, 3, 5])).toBe('Mon, Wed, Fri at 09:00 (UTC)');
		expect(describe([5])).toBe('Every Friday at 09:00 (UTC)');
		expect(describe([0, 1, 2, 3, 4, 5, 6])).toBe('Every day at 09:00 (UTC)');
		expect(parseSchedule({ kind: 'days', at: '09:00', days: [] })).toBeNull();
		expect(parseSchedule({ kind: 'days', at: '09:00', days: [7] })).toBeNull();
		expect(parseSchedule({ kind: 'days', at: '09:00', days: [null] })).toBeNull();
		expect(parseSchedule({ kind: 'days', at: '09:00', days: null })).toBeNull();
	});
});

describe('the job store', () => {
	it('hands a due job to one claim only, leases it, and its result sets the next time', () => {
		const job = makeJob();
		const due = Date.parse(job.nextRunAt!) + 1000;
		expect(claimNextDueJob(due)).toMatchObject({ id: job.id, runningSince: null });
		expect(claimNextDueJob(due)).toBeNull();
		expect(getJob('user-1', job.id)).toMatchObject({ nextRunAt: new Date(due + LEASE_MS).toISOString(), runningSince: new Date(due).toISOString() });

		recordJobResult(job, 'ok', 'Sent a digest of 1', due, due + 5000);
		expect(getJob('user-1', job.id)).toMatchObject({
			nextRunAt: '2026-11-03T05:00:00.000Z',
			lastRunAt: new Date(due).toISOString(),
			lastOkAt: new Date(due).toISOString(),
			runningSince: null
		});
	});

	it('hands back a run cut short once its lease runs out', () => {
		const job = makeJob();
		const due = Date.parse(job.nextRunAt!) + 1000;
		claimNextDueJob(due);
		expect(claimNextDueJob(due + LEASE_MS - 1000)).toBeNull();
		expect(claimNextDueJob(due + LEASE_MS + 1000)).toMatchObject({ id: job.id, runningSince: new Date(due).toISOString() });
	});

	it('skips everything while paused', () => {
		const job = makeJob();
		setJobsPaused('user-1', true);
		expect(claimNextDueJob(Date.parse(job.nextRunAt!) + 1000)).toBeNull();
	});

	it('retries a failed run after a growing delay, never past its next regular time', () => {
		const job = makeJob();
		const now = at('2026-11-02T05:00:00Z');
		recordJobResult(job, 'failed', 'boom', now, now);
		expect(getJob('user-1', job.id)!.nextRunAt).toBe(new Date(now + 5 * MIN).toISOString());
		recordJobResult(job, 'failed', 'boom', now, now);
		expect(getJob('user-1', job.id)!.nextRunAt).toBe(new Date(now + 10 * MIN).toISOString());
		// Late in the day, the next regular run comes before an hour's retry.
		for (let i = 0; i < 2; i++) recordJobResult(job, 'retry', 'busy', now, now);
		const late = at('2026-11-03T04:30:00Z');
		recordJobResult(job, 'retry', 'busy', late, late);
		expect(getJob('user-1', job.id)!.nextRunAt).toBe('2026-11-03T05:00:00.000Z');
	});

	it('keeps retrying a one-off instead of dropping it after one failure', () => {
		const job = makeJob({ schedule: { kind: 'once', at: '2026-11-01T17:00' } });
		const now = at('2026-11-01T14:00:00Z');
		recordJobResult(job, 'retry', 'The AI service is rate limiting this account', now, now);
		expect(getJob('user-1', job.id)).toMatchObject({ enabled: true, nextRunAt: new Date(now + 5 * MIN).toISOString(), failures: 0 });
		recordJobResult(job, 'ok', 'No changes', now, now);
		expect(getJob('user-1', job.id)).toMatchObject({ nextRunAt: null, retries: 0 });
	});

	it('gives a one-off up after its tries run out, instead of running it days late', () => {
		const job = makeJob({ schedule: { kind: 'once', at: '2026-11-01T17:00' } });
		const now = at('2026-11-01T14:00:00Z');
		let last = { disabled: false, givenUp: false, nextRunAt: null as string | null };
		for (let i = 0; i < 10; i++) last = recordJobResult(job, 'skipped', 'The account needs its password again', now, now);
		expect(last.givenUp).toBe(true);
		expect(getJob('user-1', job.id)).toMatchObject({ nextRunAt: null, lastResult: 'Gave up: The account needs its password again' });
	});

	it('skips the next regular run when a retry only just worked before it', () => {
		const job = makeJob();
		// Retrying since the morning; it works at 07:45 local, a quarter-hour before 08:00.
		const early = at('2026-11-02T03:00:00Z');
		recordJobResult(job, 'retry', 'busy', early, early);
		const worked = at('2026-11-02T04:45:00Z');
		recordJobResult(job, 'ok', 'Sent a digest of 3', worked, worked);
		expect(getJob('user-1', job.id)!.nextRunAt).toBe('2026-11-03T05:00:00.000Z');
	});

	it('says nothing about a next try for a job switched off while it ran', () => {
		const job = makeJob({ schedule: { kind: 'once', at: '2026-11-01T17:00' } });
		setJobEnabled('user-1', job.id, false);
		const now = at('2026-11-01T14:00:00Z');
		expect(recordJobResult(job, 'retry', 'busy', now, now).nextRunAt).toBeNull();
	});

	it('switches a job off after five failures in a row, but not for outages or skips', () => {
		const job = makeJob();
		const now = SUNDAY_9AM_UTC;
		for (let i = 0; i < 4; i++) expect(recordJobResult(job, 'failed', 'boom', now, now).disabled).toBe(false);
		for (let i = 0; i < 10; i++) recordJobResult(job, i % 2 ? 'retry' : 'skipped', 'down', now, now);
		expect(getJob('user-1', job.id)).toMatchObject({ enabled: true, failures: 4 });
		expect(recordJobResult(job, 'failed', 'boom', now, now).disabled).toBe(true);
		expect(getJob('user-1', job.id)).toMatchObject({ enabled: false, failures: 5, lastResult: 'boom' });
		expect(mocks.logEvent).toHaveBeenCalledWith('warn', 'jobs', 'disabled', expect.objectContaining({ job: job.id }));
	});

	it('moves the digest window on only when a run works', () => {
		const job = makeJob();
		const first = at('2026-11-02T05:00:00Z');
		recordJobResult(job, 'ok', 'Sent', first, first);
		const second = at('2026-11-03T05:00:00Z');
		recordJobResult(job, 'retry', 'Telegram is down', second, second);
		expect(getJob('user-1', job.id)).toMatchObject({ lastRunAt: new Date(second).toISOString(), lastOkAt: new Date(first).toISOString() });
	});

	it('runs a one-off that never worked as soon as it is switched back on', () => {
		const job = makeJob({ schedule: { kind: 'once', at: '2026-11-01T17:00' } });
		const later = at('2026-11-02T09:00:00Z');
		setJobEnabled('user-1', job.id, false, later);
		setJobEnabled('user-1', job.id, true, later);
		expect(getJob('user-1', job.id)).toMatchObject({ enabled: true, nextRunAt: new Date(later).toISOString() });

		recordJobResult(job, 'ok', 'Done', later, later);
		setJobEnabled('user-1', job.id, false, later);
		setJobEnabled('user-1', job.id, true, later);
		expect(getJob('user-1', job.id)!.nextRunAt).toBeNull();
	});

	it('on unpause, moves stale runs on to their next time and reports stale one-offs', () => {
		const daily = makeJob();
		const once = makeJob({ title: 'Check reply', schedule: { kind: 'once', at: '2026-11-01T17:00' } });
		const soon = makeJob({ title: 'Hourly', schedule: { kind: 'hourly' } });
		setJobsPaused('user-1', true, SUNDAY_9AM_UTC);
		// Three days later; the hourly job fell due just now.
		const back = at('2026-11-04T10:05:00Z');
		getDb().prepare(`UPDATE agent_jobs SET next_run_at = ? WHERE id = ?`).run('2026-11-04T10:00:00.000Z', soon.id);
		setJobsPaused('user-1', false, back);
		expect(getJob('user-1', daily.id)!.nextRunAt).toBe('2026-11-05T05:00:00.000Z');
		expect(getJob('user-1', once.id)).toMatchObject({ nextRunAt: null, lastResult: 'Missed while paused' });
		expect(getJob('user-1', soon.id)!.nextRunAt).toBe('2026-11-04T10:00:00.000Z');
		expect(claimNextDueJob(back)?.id).toBe(soon.id);
		expect(claimNextDueJob(back)).toBeNull();
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
		budget: newTurnBudget(),
		mailboxes: async () => []
	});
	const input = {
		title: 'Promotions sweep',
		what: { kind: 'tidy', scope: null, tabs: ['promotions'], older_than_hours: 24, action: 'mark_read', instructions: null },
		when: { kind: 'daily', at: '21:00', day: null, days: [] }
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

	it('takes a working week of chosen days, and names them', async () => {
		const result = await tool.run(ctx('chat'), { ...input, when: { kind: 'days', at: '08:00', day: null, days: [0, 1, 2, 3, 4] } });
		expect(result.content).toContain('Sun–Thu at 08:00 (Asia/Amman)');
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
		const job = makeJob({ title: 'Sweep', spec: { kind: 'tidy', tabs: ['promotions'], olderThanHours: 24, action: 'mark_read' }, schedule: { kind: 'daily', at: '21:00' } });
		const result = await runJob(job, SUNDAY_9AM_UTC);
		expect(result).toEqual({ status: 'ok', result: 'Marked read 2' });
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

	it('sends a digest written by the writer model, picking Important mail in the query itself', async () => {
		mocks.searchEmails.mockResolvedValue({
			emails: [{ id: 'a', keywords: {}, from: [{ name: 'Dana', email: 'd@example.test' }], subject: 'Contract' }],
			total: 1
		});
		const job = makeJob({ title: 'Morning' });

		expect(await runJob(job, SUNDAY_9AM_UTC)).toEqual({ status: 'ok', result: 'Sent a digest of 1' });
		const [, , filter, options] = mocks.searchEmails.mock.calls[0];
		expect(filter.conditions).toEqual([
			{ inMailbox: 'IN' },
			{ notKeyword: '$seen' },
			{ after: '2026-10-31T09:00:00.000Z' },
			categoryCondition('important')
		]);
		expect(options).toEqual({ limit: 20 });
		expect(mocks.runChat.mock.calls[0][0].messages[0].content).toBe('- Dana: Contract');
		expect(mocks.sendMessage).toHaveBeenCalledWith('555', '<b>Morning</b>\nDana needs the contract today.');
	});

	it('picks up from the last digest that went out, and counts what didn’t fit', async () => {
		const emails = Array.from({ length: 20 }, (_, i) => ({ id: `e${i}`, keywords: {}, from: [{ email: `s${i}@example.test` }], subject: `S${i}` }));
		mocks.searchEmails.mockResolvedValue({ emails, total: 26 });
		const job = { ...makeJob(), lastOkAt: '2026-10-30T05:00:00.000Z' };
		expect(await runJob(job, SUNDAY_9AM_UTC)).toEqual({ status: 'ok', result: 'Sent a digest of 26' });
		expect(mocks.searchEmails.mock.calls[0][2].conditions).toContainEqual({ after: '2026-10-30T05:00:00.000Z' });
		expect(mocks.runChat.mock.calls[0][0].messages[0].content).toMatch(/\n…and 6 more$/);
	});

	it('sends the plain list when the writer model fails', async () => {
		mocks.searchEmails.mockResolvedValue({ emails: [{ id: 'a', keywords: {}, from: [{ name: 'Dana & Co' }], subject: 'Contract' }], total: 1 });
		mocks.runChat.mockRejectedValueOnce(new MailAssistantError('The AI service returned an error (529)', 502, true));
		const job = makeJob({ title: 'Morning' });
		expect(await runJob(job, SUNDAY_9AM_UTC)).toEqual({ status: 'ok', result: 'Sent a digest of 1' });
		expect(mocks.sendMessage).toHaveBeenCalledWith('555', '<b>Morning</b>\n- Dana &amp; Co: Contract');
		expect(mocks.logEvent).toHaveBeenCalledWith('warn', 'jobs', 'digest_writer_failed', expect.objectContaining({ job: job.id, error: 'The AI service returned an error (529)' }));
	});

	it('skips a digest, before any mail is read, while Telegram is off or the account needs its password', async () => {
		const job = makeJob();
		mocks.link = { chatId: '555', paused: true };
		expect(await runJob(job, SUNDAY_9AM_UTC)).toEqual({ status: 'skipped', result: 'Telegram isn’t linked or is paused' });
		mocks.link = null;
		expect((await runJob(job, SUNDAY_9AM_UTC)).status).toBe('skipped');
		mocks.link = { chatId: '555', paused: false };
		mocks.needsReauth = 1;
		expect(await runJob(job, SUNDAY_9AM_UTC)).toEqual({ status: 'skipped', result: 'The account needs its password again' });
		expect(mocks.getMailboxes).not.toHaveBeenCalled();
		expect(mocks.runChat).not.toHaveBeenCalled();
	});

	describe('an agent job', () => {
		const agentJob = () => makeJob({ title: 'Bank check', spec: { kind: 'agent', instructions: 'Tell me if the bank wrote' } });

		it('reports its answer and changes to Telegram', async () => {
			mocks.runAgentTurn.mockResolvedValue({ message: 'The bank wrote <today>.', done: ['Archived 2'], pending: [] });
			expect(await runJob(agentJob(), SUNDAY_9AM_UTC)).toEqual({ status: 'ok', result: 'Archived 2' });
			expect(mocks.sendMessage).toHaveBeenCalledWith('555', '<b>Bank check</b>\nThe bank wrote &lt;today&gt;.\n\n• Archived 2');
		});

		it('keeps the answer when Telegram is off', async () => {
			mocks.runAgentTurn.mockResolvedValue({ message: 'The bank wrote today.', done: [], pending: [] });
			mocks.link = { chatId: '555', paused: true };
			expect(await runJob(agentJob(), SUNDAY_9AM_UTC)).toEqual({ status: 'ok', result: 'Not sent to Telegram: The bank wrote today.' });
			expect(mocks.sendMessage).not.toHaveBeenCalled();
		});

		it('doesn’t count a failed report as a failed run once the work is done', async () => {
			mocks.runAgentTurn.mockResolvedValue({ message: 'The bank wrote today.', done: ['Archived 2'], pending: [] });
			mocks.sendMessage.mockRejectedValueOnce(new TelegramError('Bad Gateway', 502));
			expect(await runJob(agentJob(), SUNDAY_9AM_UTC)).toEqual({ status: 'ok', result: 'Not sent to Telegram: The bank wrote today.' });
			expect(mocks.logEvent).toHaveBeenCalledWith('warn', 'jobs', 'report_not_sent', expect.objectContaining({ status: 502 }));
		});

		it('cuts a long report to fit one Telegram message', async () => {
			mocks.runAgentTurn.mockResolvedValue({ message: '&'.repeat(1500), done: Array.from({ length: 60 }, (_, i) => `Moved message ${i} ${'x'.repeat(80)}`), pending: [] });
			await runJob(agentJob(), SUNDAY_9AM_UTC);
			const html = mocks.sendMessage.mock.calls[0][1] as string;
			const text = html.replace(/<\/?b>/g, '').replace(/&amp;|&lt;|&gt;/g, '_');
			expect(text.length).toBeLessThan(4096);
		});
	});
});

describe('what a thrown error means for a job', () => {
	it('retries outages upstream without counting them, and counts what would fail again', () => {
		expect(thrownStatus(new MailAssistantError('The AI service is rate limiting this account', 502, true))).toBe('retry');
		expect(thrownStatus(new MailAssistantError('The AI service rejected its API key', 502))).toBe('failed');
		expect(thrownStatus(new TelegramError('Too Many Requests', 429))).toBe('retry');
		expect(thrownStatus(new TelegramError('Bad Gateway', 502))).toBe('retry');
		expect(thrownStatus(new TelegramError('Forbidden: bot was blocked by the user', 403))).toBe('failed');
		expect(thrownStatus(new JMAPError('JMAP request failed: 403 CrowdSec Ban'))).toBe('retry');
		expect(thrownStatus(new JMAPMethodError('invalidArguments', 'bad filter'))).toBe('failed');
		// The server's own trouble, by RFC 8620, and refusals that won't change.
		expect(thrownStatus(new JMAPMethodError('serverUnavailable', 'upgrading'))).toBe('retry');
		expect(thrownStatus(new JMAPError('JMAP request failed: 503 Service Unavailable', 503))).toBe('retry');
		expect(thrownStatus(new JMAPError('JMAP request failed: 404 Not Found', 404))).toBe('failed');
		expect(thrownStatus(new JMAPError('JMAP request failed: 400 Bad Request', 400))).toBe('failed');
		expect(thrownStatus(new JMAPAuthError('Authentication failed'))).toBe('skipped');
		expect(thrownStatus(new TypeError('fetch failed'))).toBe('retry');
		expect(thrownStatus(new DOMException('The operation timed out', 'TimeoutError'))).toBe('retry');
		// A bug is not an outage.
		expect(thrownStatus(new TypeError('Cannot read properties of undefined'))).toBe('failed');
	});
});
