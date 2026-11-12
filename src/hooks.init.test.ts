import { describe, expect, it, vi } from 'vitest';

const starts = vi.hoisted(() => ({
	migrate: vi.fn(),
	reminders: vi.fn(),
	mailPipeline: vi.fn(),
	trash: vi.fn(),
	scheduledSend: vi.fn(),
	push: vi.fn(),
	telegram: vi.fn(),
	jobs: vi.fn(),
	search: vi.fn()
}));
vi.mock('$app/environment', () => ({ building: false }));
vi.mock('$lib/server/db/migrate', () => ({ runMigrations: starts.migrate }));
vi.mock('$lib/server/reminder-scheduler', () => ({ startReminderScheduler: starts.reminders, processDueRemindersForUser: vi.fn() }));
vi.mock('$lib/server/trash-retention', () => ({ startTrashRetentionScheduler: starts.trash }));
vi.mock('$lib/server/mail-pipeline', () => ({ startMailPipeline: starts.mailPipeline, requestPass: vi.fn() }));
vi.mock('$lib/server/scheduled-send', () => ({ startScheduledSendWorker: starts.scheduledSend }));
vi.mock('$lib/server/push/worker', () => ({ startPushWorker: starts.push }));
vi.mock('$lib/server/telegram/worker', () => ({ startTelegramWorker: starts.telegram }));
vi.mock('$lib/server/jobs/worker', () => ({ startJobWorker: starts.jobs }));
vi.mock('$lib/server/search/worker', () => ({ startSearchIndexer: starts.search }));
vi.mock('$lib/server/auth/crypto', () => ({ assertCryptoReady: () => {} }));
vi.mock('$lib/server/auth/user', () => ({ getUserById: vi.fn(), hasAppUser: () => true }));
vi.mock('$lib/server/auth/app-session', () => ({ getAppSession: vi.fn(), verifiedAtMs: vi.fn() }));
vi.mock('$lib/server/auth/accounts', () => ({ authStateForAccount: vi.fn(), listAccounts: vi.fn(() => []), toPublic: vi.fn() }));

import { handle, init } from './hooks.server';

describe('server start', () => {
	it('runs migrations and starts every background worker before any request, once', async () => {
		await init();
		for (const start of Object.values(starts)) expect(start).toHaveBeenCalledTimes(1);

		// The first request doesn't start them again.
		await handle({
			event: {
				url: new URL('https://mail.example.test/inbox'),
				request: new Request('https://mail.example.test/inbox'),
				cookies: { get: () => undefined, delete: vi.fn() },
				locals: {}
			},
			resolve: async () => new Response('ok')
		} as unknown as Parameters<typeof handle>[0]);
		for (const start of Object.values(starts)) expect(start).toHaveBeenCalledTimes(1);
	});
});
