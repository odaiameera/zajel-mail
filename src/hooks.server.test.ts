import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ hasAppUser: true, session: null as { id: string; user_id: string } | null }));

vi.mock('$lib/server/db/migrate', () => ({ runMigrations: vi.fn() }));
vi.mock('$lib/server/reminder-scheduler', () => ({
	startReminderScheduler: vi.fn(),
	processDueRemindersForUser: vi.fn()
}));
vi.mock('$lib/server/rules-scheduler', () => ({ startRulesScheduler: vi.fn(), applyRulesForUserSafe: vi.fn() }));
vi.mock('$lib/server/trash-retention', () => ({ startTrashRetentionScheduler: vi.fn() }));
vi.mock('$lib/server/jev/worker', () => ({ startJevScheduler: vi.fn(), sortNewMailSafe: vi.fn() }));
vi.mock('$lib/server/scheduled-send', () => ({ startScheduledSendWorker: vi.fn() }));
vi.mock('$lib/server/push/worker', () => ({ startPushWorker: vi.fn() }));
vi.mock('$lib/server/telegram/worker', () => ({ startTelegramWorker: vi.fn() }));
vi.mock('$lib/server/auth/crypto', () => ({ assertCryptoReady: vi.fn() }));
vi.mock('$lib/server/auth/app-session', () => ({ getAppSession: () => mocks.session, verifiedAtMs: () => null }));
vi.mock('$lib/server/auth/user', () => ({
	getUserById: (id: string) => ({ id, email: 'me@example.test' }),
	hasAppUser: () => mocks.hasAppUser
}));
vi.mock('$lib/server/auth/accounts', () => ({
	listAccounts: () => [],
	authStateForAccount: vi.fn(),
	toPublic: (a: unknown) => a
}));

import { handle } from './hooks.server';

const MB = 1024 * 1024;

async function post(path: string, bytes: number, signedIn: boolean, headers: Record<string, string> = {}) {
	mocks.session = signedIn ? { id: 's1', user_id: 'u1' } : null;
	const url = new URL(`http://localhost${path}`);
	const resolve = vi.fn(async () => new Response('ok'));
	const res = await handle({
		event: {
			url,
			request: new Request(url, { method: 'POST', headers: { 'content-length': String(bytes), ...headers } }),
			cookies: { get: (name: string) => (name === 'session' ? 's1' : undefined), delete: vi.fn() },
			locals: {}
		} as unknown as Parameters<typeof handle>[0]['event'],
		resolve
	});
	return { status: res.status, resolved: resolve.mock.calls.length > 0 };
}

beforeEach(() => {
	mocks.hasAppUser = true;
});

describe('request body size before sign-in', () => {
	it('turns away a large body from someone signed out', async () => {
		expect(await post('/login', 2 * MB, false)).toEqual({ status: 413, resolved: false });
		expect(await post('/login', 4096, false)).toEqual({ status: 200, resolved: true });
	});

	it('does the same during first-run setup', async () => {
		mocks.hasAppUser = false;
		expect(await post('/setup', 2 * MB, false)).toEqual({ status: 413, resolved: false });
	});

	it('lets a signed-in upload through', async () => {
		expect(await post('/api/upload', 20 * MB, true)).toEqual({ status: 200, resolved: true });
	});
});

describe('cross-site writes', () => {
	it('refuses a write whose Origin is another site, sibling subdomains included', async () => {
		for (const origin of ['https://evil.example', 'http://mail.localhost', 'null']) {
			expect(await post('/api/email/bulk', 100, true, { origin })).toEqual({ status: 403, resolved: false });
		}
	});

	it('lets same-origin writes and requests without an Origin through', async () => {
		expect(await post('/api/email/bulk', 100, true, { origin: 'http://localhost' })).toEqual({ status: 200, resolved: true });
		expect(await post('/api/email/bulk', 100, true)).toEqual({ status: 200, resolved: true });
	});
});
