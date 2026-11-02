import { describe, expect, it } from 'vitest';
import { calendarIdFromHref, hrefToId, idToHref, isCollectionId } from './caldav';

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
