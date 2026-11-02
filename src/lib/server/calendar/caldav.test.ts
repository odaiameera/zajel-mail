import { afterEach, describe, expect, it, vi } from 'vitest';
import { calendarHomeHref, calendarIdFromHref, hrefToId, idToHref, isCollectionId, resolveCalendarHome } from './caldav';

const USER = 'u@x.com';
const HOME = '/dav/cal/u%40x.com/';

describe('idToHref', () => {
	it('round-trips an href inside the home, encoded as the server sent it', () => {
		for (const href of [`${HOME}default/evt.ics`, `${HOME}default/a%20b.ics`, `${HOME}work-1a2b/%D9%85.ics`]) {
			expect(idToHref(hrefToId(href), USER)).toBe(href);
		}
		expect(calendarIdFromHref(`${HOME}work-1a2b/evt.ics`, USER)).toBe('work-1a2b');
	});

	it('rejects ids whose resolved path leaves the home, however the dots are spelled', () => {
		const forged = [
			`${HOME}%2e%2e/victim%40x.com/default/evt.ics`,
			`${HOME}../victim%40x.com/default/evt.ics`,
			`${HOME}default/%2E%2E/%2E%2E/victim%40x.com/default/evt.ics`,
			'/dav/cal/victim%40x.com/default/evt.ics',
			`${HOME}default/evt.ics?x=1`,
			'dav/cal/u%40x.com/default/evt.ics'
		];
		for (const href of forged) expect(idToHref(hrefToId(href), USER), href).toBeNull();
		expect(idToHref('not base64 at all!!', USER)).toBeNull();
	});
});

describe('isCollectionId', () => {
	it('allows one path segment and nothing that climbs out of the home', () => {
		expect(isCollectionId('default')).toBe(true);
		expect(isCollectionId('work-1a2b')).toBe(true);
		for (const bad of ['', '.', '..', 'a/b', 'a\\b', 'x\u0000', 'a'.repeat(256)]) {
			expect(isCollectionId(bad), JSON.stringify(bad)).toBe(false);
		}
	});
});

/**
 * Calendar-home resolution against a fake Stalwart, ported from the old
 * tests/caldav-discovery.mjs (whose mock server never made it into the repo).
 */
describe('resolveCalendarHome', () => {
	const REAL_HOME = '/dav/cal/user%40example.test/';
	const PRINCIPAL = '/dav/pal/user%40example.test/';
	const multistatus = (href: string, prop: string) =>
		`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>${href}</d:href><d:propstat><d:prop>${prop}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`;

	/** Answers PROPFINDs the way Stalwart does for user@example.test, logged in as that user. */
	function fakeStalwart(seen: string[]) {
		return vi.fn(async (url: string | URL, init?: RequestInit) => {
			const path = new URL(String(url)).pathname;
			seen.push(`${init?.method} ${path}`);
			const body = String(init?.body ?? '');
			if (path === REAL_HOME) return new Response(multistatus(REAL_HOME, '<d:resourcetype><d:collection/></d:resourcetype>'), { status: 207 });
			if (path === '/dav/' && body.includes('current-user-principal'))
				return new Response(multistatus('/dav/', `<d:current-user-principal><d:href>${PRINCIPAL}</d:href></d:current-user-principal>`), { status: 207 });
			if (path === PRINCIPAL && body.includes('calendar-home-set'))
				return new Response(multistatus(PRINCIPAL, `<c:calendar-home-set><d:href>${REAL_HOME}</d:href></c:calendar-home-set>`), { status: 207 });
			return new Response('', { status: 404 });
		});
	}

	const auth = (email: string) => ({
		authHeader: `Basic ${Buffer.from(`${email}:pw`).toString('base64')}`,
		accountId: 'acc1',
		apiUrl: 'https://mx.example.test/jmap/',
		sessionState: ''
	});

	afterEach(() => vi.unstubAllGlobals());

	it('keeps the conventional home when the server answers it, without discovery', async () => {
		const seen: string[] = [];
		vi.stubGlobal('fetch', fakeStalwart(seen));
		expect(await resolveCalendarHome(auth('user@example.test') as never, 'user@example.test')).toBe(REAL_HOME);
		expect(seen).toEqual([`PROPFIND ${REAL_HOME}`]);
	});

	it('finds the real home through the principal when the address is not the DAV login', async () => {
		const seen: string[] = [];
		vi.stubGlobal('fetch', fakeStalwart(seen));
		expect(await resolveCalendarHome(auth('user@example.test') as never, 'alias@example.test')).toBe(REAL_HOME);
		expect(calendarHomeHref('alias@example.test')).toBe(REAL_HOME);
		expect(seen).toContain(`PROPFIND ${PRINCIPAL}`);
	});

	it('falls back to the conventional home when discovery finds nothing', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
		expect(await resolveCalendarHome(auth('x@example.test') as never, 'other@example.test')).toBe('/dav/cal/other%40example.test/');
	});
});
