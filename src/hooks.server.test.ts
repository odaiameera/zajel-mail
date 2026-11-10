import { createHash } from 'node:crypto';
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

describe('a navigation another site started', () => {
	const CROSS_SITE = { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-site': 'cross-site' };
	const tag = (target: string) => createHash('sha256').update(target).digest('base64url').slice(0, 22);

	/**
	 * The route SvelteKit would match, roughly: it decodes the path first, and
	 * static files, the build's assets and `//...` match none.
	 */
	function routeFor(pathname: string): string | null {
		const decoded = decodeURIComponent(pathname);
		if (pathname.startsWith('//') || decoded.startsWith('/_app/')) return null;
		if (decoded.slice(decoded.lastIndexOf('/') + 1).includes('.')) return null;
		return decoded;
	}

	/** A GET with these cookies (the session cookie only if given). */
	async function navigate(path: string, headers: Record<string, string>, jar: Record<string, string> = {}) {
		mocks.session = jar.session ? { id: jar.session, user_id: 'u1' } : null;
		const url = new URL(`http://localhost${path}`);
		const cookies = { get: (name: string) => jar[name], set: vi.fn(), delete: vi.fn() };
		const event = {
			url,
			route: { id: routeFor(url.pathname) },
			request: new Request(url, { headers }),
			cookies,
			locals: {}
		} as unknown as Parameters<typeof handle>[0]['event'];
		const resolve = vi.fn(async () => new Response('page'));
		const res = await handle({ event, resolve });
		return { res, resolved: resolve.mock.calls.length > 0, cookies };
	}

	it('loads the address again from this site, so the SameSite=Strict session cookie comes with it', async () => {
		const { res, resolved } = await navigate('/login', CROSS_SITE);
		expect(resolved).toBe(false);
		expect(res.status).toBe(200);
		expect(res.headers.get('cache-control')).toBe('no-store');
		expect(res.headers.get('set-cookie')).toBe(
			`same_site_retry=${tag('/login')}; Path=/; Max-Age=10; HttpOnly; Secure; SameSite=Lax`
		);
		expect(await res.text()).toContain('<meta http-equiv="refresh" content="0;url=/login">');
	});

	it('keeps a deep link\'s path and query, and works when the service worker passes the navigation on', async () => {
		const { res } = await navigate('/inbox?category=updates&page=2', { ...CROSS_SITE, 'sec-fetch-dest': 'empty' });
		const html = await res.text();
		expect(html).toContain('content="0;url=/inbox?category=updates&amp;page=2"');
		expect(html).toContain('<a href="/inbox?category=updates&amp;page=2">');
		expect((await navigate('/email/abc', CROSS_SITE)).resolved).toBe(false);
	});

	it('names an address on this site only, with nothing from the request able to leave the attribute', async () => {
		// `//...` would name another host as a reload target; it matches no
		// route, so it is served as it is.
		expect((await navigate('//evil.example/x', CROSS_SITE)).resolved).toBe(true);

		const html = await (await navigate('/login?next="><script>alert(1)</script>\'', CROSS_SITE)).res.text();
		expect(html).not.toContain('<script');
		expect(html.match(/"/g)?.length).toBe(
			(await (await navigate('/login', CROSS_SITE)).res.text()).match(/"/g)?.length
		);
	});

	it('serves the page as usual when that address comes back still counted as cross-site, instead of looping', async () => {
		const { resolved, cookies } = await navigate('/login', CROSS_SITE, { same_site_retry: tag('/login') });
		expect(resolved).toBe(true);
		expect(cookies.delete).toHaveBeenCalledWith('same_site_retry', { path: '/' });
	});

	it("doesn't let one address's retry cookie switch the retry off for another, or a stale one", async () => {
		expect((await navigate('/calendar?date=2026-12-01', CROSS_SITE, { same_site_retry: tag('/login') })).resolved).toBe(false);
		expect((await navigate('/login', CROSS_SITE, { same_site_retry: '1' })).resolved).toBe(false);
	});

	it('spends the cookie on the reload from this site, so the next link to that address is retried too', async () => {
		const { resolved, cookies } = await navigate(
			'/login',
			{ ...CROSS_SITE, 'sec-fetch-site': 'same-origin' },
			{ session: 's1', same_site_retry: tag('/login') }
		);
		expect(resolved).toBe(true);
		expect(cookies.delete).toHaveBeenCalledWith('same_site_retry', { path: '/' });
	});

	it('keeps the API, the build and static files out of it', async () => {
		for (const path of [
			'/api/auth/sessions',
			'/api/avatar?email=a%40b.test',
			'/api/image-proxy?url=http%3A%2F%2F127.0.0.1',
			// Spellings SvelteKit still routes to the API, or that a reload
			// with the slashes collapsed would.
			'//api/auth/sessions',
			'/%61pi/accounts',
			'/api',
			'/_app/immutable/entry/start.js',
			'/manifest.webmanifest',
			'/offline.html'
		]) {
			expect((await navigate(path, CROSS_SITE)).resolved, path).toBe(true);
		}
	});

	it('leaves alone requests that carry the session cookie, or that this site or the address bar started', async () => {
		expect((await navigate('/login', CROSS_SITE, { session: 'stale' })).resolved).toBe(true);
		for (const site of ['same-origin', 'same-site', 'none']) {
			expect((await navigate('/login', { ...CROSS_SITE, 'sec-fetch-site': site })).resolved).toBe(true);
		}
		// No fetch metadata at all: an older browser, or not a browser.
		expect((await navigate('/login', {})).resolved).toBe(true);
	});

	it('leaves alone frames and requests that are not page loads', async () => {
		expect((await navigate('/login', { ...CROSS_SITE, 'sec-fetch-dest': 'iframe' })).resolved).toBe(true);
		expect((await navigate('/inbox', { ...CROSS_SITE, 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' })).resolved).toBe(true);
	});

	it("keeps another site's handle off the window of a page it opened", async () => {
		mocks.session = { id: 's1', user_id: 'u1' };
		const { event } = stubEvent('/inbox', { method: 'GET' });
		const page = await handle({ event, resolve: async () => new Response('<p>', { headers: { 'content-type': 'text/html' } }) });
		expect(page.headers.get('cross-origin-opener-policy')).toBe('same-origin');
		const json = await handle({ event, resolve: async () => Response.json({}) });
		expect(json.headers.get('cross-origin-opener-policy')).toBeNull();
		// Headers passed through from a fetch() can't be changed; that's no error.
		const passedThrough = new Response('<p>', { headers: { 'content-type': 'text/html' } });
		Object.defineProperty(passedThrough.headers, 'set', {
			value: () => {
				throw new TypeError('immutable');
			}
		});
		expect((await handle({ event, resolve: async () => passedThrough })).status).toBe(200);
	});

	it('comes after the first-run gate, which still sends everything to /setup', async () => {
		// The gate remembers once it has seen the master user, so this needs a
		// module that hasn't yet.
		vi.resetModules();
		mocks.hasAppUser = false;
		const fresh = await import('./hooks.server');
		const run = (path: string) => {
			const url = new URL(`http://localhost${path}`);
			const event = {
				url,
				route: { id: path },
				request: new Request(url, { headers: CROSS_SITE }),
				cookies: { get: () => undefined, set: vi.fn(), delete: vi.fn() },
				locals: {}
			} as unknown as Parameters<typeof handle>[0]['event'];
			return fresh.handle({ event, resolve: async () => new Response('page') });
		};
		await expect(run('/login')).rejects.toMatchObject({ status: 303, location: '/setup' });
		expect(await (await run('/setup')).text()).toBe('page');
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
