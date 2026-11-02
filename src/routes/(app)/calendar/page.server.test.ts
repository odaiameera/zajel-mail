import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/calendar/service', () => ({
	getEventsInRange: async () => ({ calendars: [], events: [], partial: false })
}));
vi.mock('$lib/server/preferences', () => ({ readPreferences: () => ({}) }));

import { load } from './+page.server';

type LoadEvent = Parameters<typeof load>[0];

function event(url: string, cookies: Record<string, string> = {}): LoadEvent {
	return {
		locals: {
			auth: { authHeader: `Basic ${Buffer.from('me@example.test:pw').toString('base64')}`, accountId: 'a', apiUrl: '', sessionState: '' },
			user: null
		},
		url: new URL(url),
		cookies: { get: (name: string) => cookies[name] }
	} as unknown as LoadEvent;
}

beforeEach(() => {
	vi.useFakeTimers();
	// 20:00 UTC on Nov 2: already Nov 3 in Auckland, still Nov 2 in Los Angeles.
	vi.setSystemTime(new Date('2026-11-02T20:00:00Z'));
});
afterEach(() => vi.useRealTimers());

describe('/calendar without ?date=', () => {
	it("opens on today in the browser's zone when the cookie says which", async () => {
		const auckland = await load(event('http://h/calendar', { calendar_tz: 'Pacific/Auckland' }));
		expect(auckland).toMatchObject({ date: '2026-11-03', dateFromUrl: false });
		const la = await load(event('http://h/calendar', { calendar_tz: 'America/Los_Angeles' }));
		expect(la).toMatchObject({ date: '2026-11-02', dateFromUrl: false });
	});

	it('falls back to the UTC date without a usable cookie, and the URL date always wins', async () => {
		expect(await load(event('http://h/calendar'))).toMatchObject({ date: '2026-11-02', dateFromUrl: false });
		expect(await load(event('http://h/calendar', { calendar_tz: 'Mars/Olympus' }))).toMatchObject({ date: '2026-11-02' });
		expect(await load(event('http://h/calendar?date=2026-01-05', { calendar_tz: 'Pacific/Auckland' }))).toMatchObject({
			date: '2026-01-05',
			dateFromUrl: true
		});
	});
});
