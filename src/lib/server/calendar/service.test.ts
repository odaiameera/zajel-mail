import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthState } from '$lib/jmap/types';
import type { EventWritePayload } from '$lib/calendar/types';

// A CalDAV server in a Map: real hrefs and ids, fake network.
const fake = vi.hoisted(() => ({
	store: new Map<string, { ics: string; etag: string }>(),
	puts: [] as { href: string; ics: string; etag: string | null | undefined }[],
	deleted: [] as string[],
	/** Runs after each GET: a stand-in for another device writing between our read and our write. */
	afterGet: null as null | (() => void)
}));
vi.mock('./caldav', async (importOriginal) => {
	const real = await importOriginal<typeof import('./caldav')>();
	const conflict = (verb: string, href: string) => new real.CalDAVError(`${verb} ${href} failed: 412`, 412);
	return {
		...real,
		resolveCalendarHome: async () => HOME,
		listCalendars: async () => [{ id: 'default', href: `${HOME}default/`, name: 'Calendar', ctag: null }],
		queryEvents: async (_auth: AuthState, calHref: string) =>
			[...fake.store].filter(([href]) => href.startsWith(calHref)).map(([href, o]) => ({ href, etag: o.etag, ics: o.ics })),
		getObject: async (_auth: AuthState, href: string) => {
			const obj = fake.store.get(href);
			if (!obj) throw new real.CalDAVError(`GET ${href} failed: 404`, 404);
			fake.afterGet?.();
			return { href, etag: obj.etag, ics: obj.ics };
		},
		// Honours the conditional headers the real server does: If-None-Match
		// (etag null) refuses an existing object, If-Match a changed one.
		putObject: async (_auth: AuthState, href: string, ics: string, etag?: string | null) => {
			const current = fake.store.get(href);
			if (etag === null && current) throw conflict('PUT', href);
			if (etag && current?.etag !== etag) throw conflict('PUT', href);
			fake.puts.push({ href, ics, etag });
			fake.store.set(href, { ics, etag: 'etag-2' });
		},
		deleteObject: async (_auth: AuthState, href: string, etag?: string | null) => {
			if (etag && fake.store.get(href)?.etag !== etag) throw conflict('DELETE', href);
			fake.deleted.push(href);
			fake.store.delete(href);
		}
	};
});
vi.mock('../db/queries/calendar-meta', () => ({ getCalendarMetaForUser: () => new Map() }));

import { hrefToId } from './caldav';
import { expandToInstances, parseIcs } from './ics';
import { deleteEvent, upcomingReminders, updateEvent } from './service';
import { wallClockToUtc } from './tz';

const HOME = '/dav/cal/me%40example.test/';
const USER = 'me@example.test';
const HREF = `${HOME}default/p1.ics`;
const auth = { accountId: 'jmap' } as AuthState;

const wrap = (...lines: string[]) =>
	['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//EN', ...lines, 'END:VCALENDAR'].join('\r\n') + '\r\n';
const vevent = (...props: string[]) => ['BEGIN:VEVENT', 'DTSTAMP:20260101T000000Z', ...props, 'END:VEVENT'].join('\r\n');

// Weekly Monday 09:00 Riyadh standup from Nov 2 2026; Nov 9 skipped, Nov 16 moved to 11:00.
const SERIES = wrap(
	vevent('UID:p1', 'DTSTART;TZID=Asia/Riyadh:20261102T090000', 'DTEND;TZID=Asia/Riyadh:20261102T093000', 'RRULE:FREQ=WEEKLY;BYDAY=MO', 'EXDATE;TZID=Asia/Riyadh:20261109T090000', 'SUMMARY:Standup', 'SEQUENCE:3'),
	vevent('UID:p1', 'RECURRENCE-ID;TZID=Asia/Riyadh:20261116T090000', 'DTSTART;TZID=Asia/Riyadh:20261116T110000', 'DTEND;TZID=Asia/Riyadh:20261116T120000', 'SUMMARY:Standup (moved)')
);

const dateLines = (ics: string) => ics.split('\r\n').filter((l) => /^(DTSTART|DTEND|RRULE|EXDATE|RDATE|RECURRENCE-ID)/.test(l));
const line = (ics: string, name: string) => ics.split('\r\n').find((l) => l.startsWith(name));
const starts = (ics: string, from: number, to: number) => expandToInstances(parseIcs(ics), 'i', 'c', from, to).map((i) => i.start.slice(0, 16));

function payload(start: string, end: string, extra: Partial<EventWritePayload> = {}): EventWritePayload {
	return {
		calendarId: 'default',
		title: 'Standup',
		allDay: false,
		start,
		end,
		timeZone: 'Asia/Riyadh',
		description: '',
		location: '',
		rrule: { freq: 'WEEKLY', interval: 1, byDay: ['MO'] },
		keepRecurrence: true,
		alarms: [],
		attendees: [],
		status: 'confirmed',
		...extra
	};
}

beforeEach(() => {
	fake.store.clear();
	fake.puts.length = 0;
	fake.deleted.length = 0;
	fake.afterGet = null;
	fake.store.set(HREF, { ics: SERIES, etag: 'etag-1' });
});

describe('updateEvent, scope all', () => {
	it('a title edit from the Nov 30 occurrence keeps DTSTART, RRULE, EXDATE and the override, conditionally', async () => {
		await updateEvent(auth, USER, hrefToId(HREF), payload('2026-11-30T09:00', '2026-11-30T09:30', { title: 'Daily sync' }), 'all', '2026-11-30T09:00:00', null);
		expect(fake.puts).toHaveLength(1);
		const stored = fake.puts[0];
		expect(stored.etag).toBe('etag-1');
		expect(dateLines(stored.ics)).toEqual(dateLines(SERIES));
		expect(line(stored.ics, 'SEQUENCE')).toBe('SEQUENCE:4');
		expect(stored.ics.match(/^SUMMARY:Daily sync$/gm)).toHaveLength(2);
		expect(starts(stored.ics, Date.UTC(2026, 10, 1), Date.UTC(2026, 11, 1))).toEqual(starts(SERIES, Date.UTC(2026, 10, 1), Date.UTC(2026, 11, 1)));
	});

	it('a drag of the Nov 30 occurrence by an hour moves the whole series and its exceptions', async () => {
		await updateEvent(auth, USER, hrefToId(HREF), payload('2026-11-30T10:00', '2026-11-30T10:30'), 'all', '2026-11-30T09:00:00', null);
		const ics = fake.puts[0].ics;
		expect(line(ics, 'DTSTART')).toBe('DTSTART;TZID=Asia/Riyadh:20261102T100000');
		expect(line(ics, 'EXDATE')).toBe('EXDATE;TZID=Asia/Riyadh:20261109T100000');
		expect(line(ics, 'RECURRENCE-ID')).toBe('RECURRENCE-ID;TZID=Asia/Riyadh:20261116T100000');
	});

	it('keeps the stored RRULE when the recurrence controls were not touched, even if the model differs', async () => {
		fake.store.set(HREF, {
			ics: wrap(vevent('UID:p1', 'DTSTART;TZID=Europe/Berlin:20261103T090000', 'DTEND;TZID=Europe/Berlin:20261103T100000', 'RRULE:FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR', 'SUMMARY:w')),
			etag: 'etag-1'
		});
		// The modal's 'daily' preset sends a plain DAILY rule.
		await updateEvent(auth, USER, hrefToId(HREF), payload('2026-11-10T09:00', '2026-11-10T10:00', { timeZone: 'Europe/Berlin', rrule: { freq: 'DAILY', interval: 1 }, title: 'Weekday sync' }), 'all', '2026-11-10T09:00:00', null);
		expect(line(fake.puts[0].ics, 'RRULE')).toBe('RRULE:FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR');
		expect(line(fake.puts[0].ics, 'DTSTART')).toBe('DTSTART;TZID=Europe/Berlin:20261103T090000');
	});
});

describe('updateEvent, scope following', () => {
	it('splits at Nov 16: the tail carries the later override and the rule, the head ends the day before in its zone', async () => {
		const result = await updateEvent(auth, USER, hrefToId(HREF), payload('2026-11-16T11:00', '2026-11-16T12:00', { title: 'Standup v2' }), 'following', '2026-11-16T09:00:00', null);
		expect(result.id).not.toBe(hrefToId(HREF));
		const [tailPut, headPut] = fake.puts;
		expect(tailPut.etag).toBeNull();
		expect(headPut.etag).toBe('etag-1');

		// Head: Nov 2 and the Nov 9 EXDATE, ending before Nov 16 at Riyadh midnight.
		expect(line(headPut.ics, 'RRULE')).toBe('RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20261115T205959Z');
		expect(line(headPut.ics, 'EXDATE')).toBe('EXDATE;TZID=Asia/Riyadh:20261109T090000');
		expect(headPut.ics).not.toContain('RECURRENCE-ID');
		expect(starts(headPut.ics, Date.UTC(2026, 10, 1), Date.UTC(2027, 0, 1))).toEqual(['2026-11-02T06:00']);

		// Tail: the series from Nov 16 at 09:00, with Nov 16 still its moved occurrence, retitled throughout.
		const tail = parseIcs(tailPut.ics);
		expect(tail.master?.startWall).toMatchObject({ year: 2026, month: 11, day: 16, hour: 9 });
		expect(tail.master?.rruleRaw).toBe('FREQ=WEEKLY;BYDAY=MO');
		expect(tail.master?.summary).toBe('Standup v2');
		expect(tail.overrides.map((o) => [o.recurrenceId, o.summary, o.startWall.hour])).toEqual([['20261116T090000', 'Standup v2', 11]]);
		expect(starts(tailPut.ics, Date.UTC(2026, 10, 1), Date.UTC(2026, 11, 1))).toEqual(['2026-11-16T08:00', '2026-11-23T06:00', '2026-11-30T06:00']);
	});
});

describe('deleteEvent', () => {
	it('"this and following" ends a Tokyo morning series on the day before, in Tokyo', async () => {
		fake.store.set(HREF, {
			ics: wrap(vevent('UID:p1', 'DTSTART;TZID=Asia/Tokyo:20261103T080000', 'DTEND;TZID=Asia/Tokyo:20261103T090000', 'RRULE:FREQ=DAILY', 'SUMMARY:t')),
			etag: 'etag-1'
		});
		await deleteEvent(auth, USER, hrefToId(HREF), 'following', '2026-11-10T08:00:00');
		const ics = fake.puts[0].ics;
		expect(line(ics, 'RRULE')).toBe('RRULE:FREQ=DAILY;UNTIL=20261109T145959Z');
		const days = expandToInstances(parseIcs(ics), 'i', 'c', Date.UTC(2026, 10, 1), Date.UTC(2026, 11, 1)).map((i) =>
			new Date(i.start).toLocaleDateString('sv', { timeZone: 'Asia/Tokyo' })
		);
		expect(days).toHaveLength(7);
		expect(days.at(-1)).toBe('2026-11-09');
	});

	it('"this event" adds an EXDATE and drops the override for that slot, nothing else', async () => {
		await deleteEvent(auth, USER, hrefToId(HREF), 'instance', '2026-11-16T09:00:00');
		const ics = fake.puts[0].ics;
		expect(ics).not.toContain('RECURRENCE-ID');
		expect(ics.split('\r\n').filter((l) => l.startsWith('EXDATE'))).toEqual([
			'EXDATE;TZID=Asia/Riyadh:20261109T090000',
			'EXDATE;TZID=Asia/Riyadh:20261116T090000'
		]);
		expect(line(ics, 'DTSTART')).toBe('DTSTART;TZID=Asia/Riyadh:20261102T090000');
		expect(fake.deleted).toEqual([]);
	});
});

describe('writes that touch two objects', () => {
	it('"this and following" takes the new tail back when the original changed meanwhile, leaving the original alone', async () => {
		fake.afterGet = () => fake.store.set(HREF, { ics: SERIES, etag: 'etag-from-another-device' });
		await expect(
			updateEvent(auth, USER, hrefToId(HREF), payload('2026-11-16T11:00', '2026-11-16T12:00', { title: 'v2' }), 'following', '2026-11-16T09:00:00', null)
		).rejects.toMatchObject({ status: 412 });
		expect(fake.puts).toHaveLength(1);
		expect(fake.deleted).toEqual([fake.puts[0].href]);
		expect(fake.store.get(HREF)?.ics).toBe(SERIES);
	});

	it('refuses to move onto a calendar that already holds the event, and keeps the original', async () => {
		fake.store.set(`${HOME}work/p1.ics`, { ics: SERIES, etag: 'w' });
		await expect(
			updateEvent(auth, USER, hrefToId(HREF), payload('2026-11-30T09:00', '2026-11-30T09:30', { calendarId: 'work' }), 'all', '2026-11-30T09:00:00', null)
		).rejects.toMatchObject({ status: 409, message: 'That calendar already has this event' });
		expect(fake.store.has(HREF)).toBe(true);
		expect(fake.deleted).toEqual([]);
	});

	it('a move deletes the original only if it is still the version that was read', async () => {
		fake.afterGet = () => fake.store.set(HREF, { ics: SERIES, etag: 'etag-from-another-device' });
		await expect(
			updateEvent(auth, USER, hrefToId(HREF), payload('2026-11-30T09:00', '2026-11-30T09:30', { calendarId: 'work' }), 'all', '2026-11-30T09:00:00', null)
		).rejects.toMatchObject({ status: 412 });
		expect(fake.store.has(HREF)).toBe(true);
		expect(fake.store.has(`${HOME}work/p1.ics`)).toBe(false);
	});
});

describe('upcomingReminders', () => {
	const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

	it('finds a "2 days before" reminder whose event starts two days out, keyed by the occurrence start', async () => {
		const start = Date.now() + 2 * 86400000 + 10 * 60000;
		fake.store.set(HREF, {
			ics: wrap(vevent('UID:far', `DTSTART:${stamp(start)}`, `DTEND:${stamp(start + 3600000)}`, 'SUMMARY:Far', 'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-P2D', 'END:VALARM')),
			etag: 'e'
		});
		const items = await upcomingReminders(auth, USER, 30 * 60000);
		expect(items).toHaveLength(1);
		expect(items[0].minutesBefore).toBe(2880);
		expect(items[0].key).toBe(`far::2880:${new Date(Math.floor(start / 1000) * 1000).toISOString()}`);
	});

	it("fires an all-day reminder at midnight in the user's zone, not the server's", async () => {
		const zone = 'America/Los_Angeles';
		const day = new Date(Date.now() + 36 * 3600000).toLocaleDateString('sv', { timeZone: zone });
		const [y, m, d] = day.split('-').map(Number);
		const next = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10).replace(/-/g, '');
		fake.store.set(HREF, {
			ics: wrap(vevent('UID:ad', `DTSTART;VALUE=DATE:${day.replace(/-/g, '')}`, `DTEND;VALUE=DATE:${next}`, 'SUMMARY:Holiday', 'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:PT0S', 'END:VALARM')),
			etag: 'e'
		});
		const [item] = await upcomingReminders(auth, USER, 48 * 3600000, zone);
		const midnightInLa = wallClockToUtc({ year: y, month: m, day: d, hour: 0, minute: 0, second: 0 }, zone);
		expect(item.fireAt).toBe(midnightInLa);
		expect(item.fireAt).not.toBe(Date.UTC(y, m - 1, d));
	});
});
