import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	hasAppUser: true,
	session: null as { id: string; user_id: string; extended?: boolean } | null,
	runMigrations: vi.fn()
}));

vi.mock('$lib/server/db/migrate', () => ({ runMigrations: mocks.runMigrations }));
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
vi.mock('$lib/server/jobs/worker', () => ({ startJobWorker: vi.fn() }));
vi.mock('$lib/server/search/worker', () => ({ startSearchIndexer: vi.fn() }));
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

function stubEvent(path: string, init: RequestInit) {
	const url = new URL(`http://localhost${path}`);
	const cookies = {
		get: (name: string) => (name === 'session' ? 's1' : undefined),
		set: vi.fn(),
		delete: vi.fn()
	};
	return {
		cookies,
		event: { url, request: new Request(url, init), cookies, locals: {} } as unknown as Parameters<typeof handle>[0]['event']
	};
}

async function post(path: string, bytes: number, signedIn: boolean, headers: Record<string, string> = {}) {
	mocks.session = signedIn ? { id: 's1', user_id: 'u1' } : null;
	const { event } = stubEvent(path, { method: 'POST', headers: { 'content-length': String(bytes), ...headers } });
	const resolve = vi.fn(async () => new Response('ok'));
	const res = await handle({ event, resolve });
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

describe('session cookie', () => {
	it('is issued again when the server extends the session, so its lifetime slides with the row', async () => {
		mocks.session = { id: 's1', user_id: 'u1', extended: true };
		const { event, cookies } = stubEvent('/inbox', { method: 'GET' });
		await handle({ event, resolve: async () => new Response('ok') });
		expect(cookies.set).toHaveBeenCalledWith(
			'session',
			's1',
			expect.objectContaining({ httpOnly: true, secure: true, sameSite: 'strict', maxAge: 30 * 24 * 60 * 60 })
		);
	});

	it('is left alone on a request that did not extend the session', async () => {
		mocks.session = { id: 's1', user_id: 'u1', extended: false };
		const { event, cookies } = stubEvent('/inbox', { method: 'GET' });
		await handle({ event, resolve: async () => new Response('ok') });
		expect(cookies.set).not.toHaveBeenCalled();
	});
});

describe('a failed migration', () => {
	it('refuses every request with the operator message instead of serving a partial schema', async () => {
		vi.resetModules();
		mocks.runMigrations.mockClear();
		mocks.runMigrations.mockImplementationOnce(() => {
			throw new Error('Database migration 028_x.sql failed: no such table: y. Fix the database and restart.');
		});
		const fresh = await import('./hooks.server');
		const resolve = vi.fn(async () => new Response('ok'));
		for (let i = 0; i < 2; i++) {
			const { event } = stubEvent('/inbox', { method: 'GET' });
			const res = await fresh.handle({ event, resolve });
			expect(res.status).toBe(500);
			expect(await res.text()).toContain('028_x.sql');
		}
		expect(resolve).not.toHaveBeenCalled();
		// Not retried per request: the operator fixes the database and restarts.
		expect(mocks.runMigrations).toHaveBeenCalledTimes(1);
	});
});
