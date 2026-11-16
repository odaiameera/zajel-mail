import { describe, expect, it, vi } from 'vitest';
import type { Cookies } from '@sveltejs/kit';
import { rememberReturn, safeReturn, takeReturn } from './sign-in';

function jar(initial: Record<string, string> = {}) {
	const values = { ...initial };
	const cookies = {
		get: (name: string) => values[name],
		set: vi.fn((name: string, value: string) => {
			values[name] = value;
		}),
		delete: vi.fn((name: string) => {
			delete values[name];
		})
	};
	return { values, cookies: cookies as unknown as Cookies, spy: cookies };
}

describe('safeReturn', () => {
	it("accepts the app's own pages, query and all", () => {
		for (const ok of ['/email/abc', '/inbox?mailto=mailto%3Aa%40example.com%3Fsubject%3DHi', '/calendar?date=2026-12-01', '/search?q=from%3Aboss', '/settings/security']) {
			expect(safeReturn(ok), ok).toBe(ok);
		}
	});

	it('refuses anything that could leave this site', () => {
		for (const bad of ['https://evil.example/', '//evil.example/x', '/\\evil.example', '/%2Fevil.example', '/%5Cevil.example', 'inbox', '', '/a b', '/a\nb', '/é']) {
			expect(safeReturn(bad), JSON.stringify(bad)).toBeNull();
		}
		expect(safeReturn(undefined)).toBeNull();
	});

	it('refuses the API and the sign-in pages, however they are spelled', () => {
		for (const bad of ['/api/email/abc', '/%61pi/email/abc', '/API/x', '/login', '/login?x=1', '/logout', '/setup', '/reauth', '/%zz']) {
			expect(safeReturn(bad), bad).toBeNull();
		}
		expect(safeReturn('/apiary')).toBe('/apiary');
	});

	it('lets go of an address too long to carry in a cookie', () => {
		expect(safeReturn(`/inbox?mailto=${'a'.repeat(1500)}`)).toBeNull();
		expect(safeReturn(`/inbox?mailto=${'a'.repeat(1400)}`)).not.toBeNull();
	});
});

describe('rememberReturn and takeReturn', () => {
	it('lead back to the page asked for, once', () => {
		const { cookies, spy, values } = jar();
		rememberReturn(cookies, new URL('http://localhost/email/abc?x=1'));
		expect(spy.set).toHaveBeenCalledWith(
			'return_to',
			'/email/abc?x=1',
			expect.objectContaining({ path: '/', httpOnly: true, secure: true, sameSite: 'lax' })
		);
		expect(takeReturn(cookies)).toBe('/email/abc?x=1');
		expect(values.return_to).toBeUndefined();
		expect(takeReturn(cookies)).toBe('/inbox');
	});

	it('keep nothing for the inbox itself, and forget an earlier address', () => {
		const { cookies, spy, values } = jar();
		rememberReturn(cookies, new URL('http://localhost/inbox'));
		expect(spy.set).not.toHaveBeenCalled();
		expect(spy.delete).not.toHaveBeenCalled();

		rememberReturn(cookies, new URL('http://localhost/email/abc'));
		rememberReturn(cookies, new URL('http://localhost/inbox'));
		expect(values.return_to).toBeUndefined();
		expect(takeReturn(cookies)).toBe('/inbox');
	});

	it('go to the inbox, and drop the cookie, when it names somewhere unsafe', () => {
		const { cookies, values } = jar({ return_to: '//evil.example/x' });
		expect(takeReturn(cookies)).toBe('/inbox');
		expect(values.return_to).toBeUndefined();
	});
});
