import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer as createViteServer, type ViteDevServer } from 'vite';
import { sveltekit } from '@sveltejs/kit/vite';

/**
 * Every form page, POSTed through SvelteKit itself.
 *
 * Unit tests call an action function directly, which skips everything
 * SvelteKit does around it: the CSRF check, the action lookup, and the
 * rule that a page's actions can't mix `default` with named ones. A page
 * that breaks that rule answers every POST with a 500, which is how
 * password sign-in was broken from PR 51 to PR 74 with every test green.
 *
 * So this boots the real app in a Vite dev server (no build needed) and
 * posts each action, both as a plain form and the way `use:enhance` does,
 * and fails on any 500.
 */

const root = join(import.meta.dirname, '..', '..');

// Scratch database (src/test-setup.ts); the server reads the same env.
process.env.WEBMAIL_SECRET ??= 'form-actions-smoke-test-secret-0123456789abcdef';
delete process.env.ORIGIN;

let vite: ViteDevServer;
let http: Server;
let base = '';

beforeAll(async () => {
	vite = await createViteServer({
		root,
		configFile: false,
		logLevel: 'error',
		mode: 'development',
		plugins: [sveltekit()],
		optimizeDeps: { noDiscovery: true, include: [] },
		ssr: { external: ['better-sqlite3'] },
		server: { middlewareMode: true, hmr: false, watch: null }
	});
	http = createHttpServer(vite.middlewares);
	await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
	base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
}, 120_000);

afterAll(async () => {
	await new Promise((resolve) => http?.close(resolve));
	await vite?.close();
});

/** `session=...` from a response's Set-Cookie, for the next request. */
function sessionCookie(res: Response): string | null {
	for (const line of res.headers.getSetCookie()) {
		const m = /^session=([^;]+)/.exec(line);
		if (m && m[1]) return `session=${m[1]}`;
	}
	return null;
}

async function post(
	path: string,
	fields: Record<string, string> = {},
	opts: { cookie?: string | null; enhanced?: boolean } = {}
): Promise<Response> {
	return fetch(base + path, {
		method: 'POST',
		redirect: 'manual',
		headers: {
			origin: base,
			'content-type': 'application/x-www-form-urlencoded',
			...(opts.enhanced
				? { 'x-sveltekit-action': 'true', accept: 'application/json' }
				: { accept: 'text/html' }),
			...(opts.cookie ? { cookie: opts.cookie } : {})
		},
		body: new URLSearchParams(fields)
	});
}

/** POST plain and enhanced; neither may answer with a server error. */
async function expectNo500(path: string, fields: Record<string, string> = {}, cookie: string | null = null) {
	const plain = await post(path, fields, { cookie });
	expect(plain.status, `${path} (form post)`).toBeLessThan(500);
	await plain.body?.cancel();

	const enhanced = await post(path, fields, { cookie, enhanced: true });
	expect(enhanced.status, `${path} (use:enhance)`).toBeLessThan(500);
	await enhanced.body?.cancel();
	return plain;
}

function pageServerFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return pageServerFiles(path);
		return name === '+page.server.ts' ? [path] : [];
	});
}

const EMAIL = 'smoke@example.test';
const PASSWORD = 'correct horse battery';

describe('form actions through SvelteKit', () => {
	it('covers every page that has actions', () => {
		const withActions = pageServerFiles(join(root, 'src', 'routes'))
			.filter((f) => /export const actions\b/.test(readFileSync(f, 'utf8')))
			.map((f) => relative(join(root, 'src', 'routes'), f))
			.sort();
		// A new form page needs its POSTs below too.
		expect(withActions).toEqual([
			'login/+page.server.ts',
			'logout/+page.server.ts',
			'reauth/+page.server.ts',
			'setup/+page.server.ts'
		]);
	});

	it('setup, before the master login exists', async () => {
		await expectNo500('/setup?/create');
		await expectNo500('/setup?/create', { email: EMAIL, password: 'short', confirm: 'short' });
		await expectNo500('/setup?/link');

		const created = await post('/setup?/create', { email: EMAIL, password: PASSWORD, confirm: PASSWORD });
		expect(created.status).toBe(303);
		expect(created.headers.get('location')).toBe('/setup');
		const cookie = sessionCookie(created);
		expect(cookie).toBeTruthy();

		await expectNo500('/setup?/link', {}, cookie);
		await expectNo500('/setup?/create', { email: EMAIL, password: PASSWORD, confirm: PASSWORD });
	}, 60_000);

	it('login, with each named action', async () => {
		await expectNo500('/login?/password');
		await expectNo500('/login?/password', { email: EMAIL, password: 'wrong password' });
		await expectNo500('/login?/code', { code: '123456' });
		await expectNo500('/login?/cancel');
		await expectNo500('/login');

		const signedIn = await post('/login?/password', { email: EMAIL, password: PASSWORD });
		expect(signedIn.status).toBe(303);
		expect(signedIn.headers.get('location')).toBe('/inbox');
		expect(sessionCookie(signedIn)).toBeTruthy();
	}, 60_000);

	it('reauth and logout', async () => {
		const signedIn = await post('/login?/password', { email: EMAIL, password: PASSWORD });
		const cookie = sessionCookie(signedIn);
		expect(cookie).toBeTruthy();

		await expectNo500('/reauth', {}, cookie);
		await expectNo500('/reauth', { password: 'x' }, cookie);
		await expectNo500('/reauth');

		const out = await expectNo500('/logout', {}, cookie);
		expect(out.status).toBe(303);
		await expectNo500('/logout');
	}, 60_000);
});

// The same rule checked without a server, so it names the page at fault.
const modules = import.meta.glob<{ actions?: Record<string, unknown> }>('./**/+page.server.ts');

describe('form action shape', () => {
	it.each(Object.keys(modules).sort())('%s does not mix a default action with named ones', async (file) => {
		const names = Object.keys((await modules[file]()).actions ?? {});
		expect(names.includes('default') && names.length > 1).toBe(false);
	});
});
