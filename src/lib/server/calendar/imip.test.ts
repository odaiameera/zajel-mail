import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthState } from '$lib/jmap/types';

const fake = vi.hoisted(() => ({
	store: new Map<string, { ics: string; etag: string }>(),
	puts: [] as { href: string; ics: string; etag: string | null | undefined }[],
	deleted: [] as string[]
}));
vi.mock('./caldav', async (importOriginal) => {
	const real = await importOriginal<typeof import('./caldav')>();
	return {
		...real,
		getObject: async (_auth: AuthState, href: string) => {
			const obj = fake.store.get(href);
			if (!obj) throw new real.CalDAVError(`GET ${href} failed: 404`, 404);
			return { href, etag: obj.etag, ics: obj.ics };
		},
		putObject: async (_auth: AuthState, href: string, ics: string, etag?: string | null) => {
			fake.puts.push({ href, ics, etag });
			fake.store.set(href, { ics, etag: 'etag-2' });
		},
		deleteObject: async (_auth: AuthState, href: string) => {
			fake.deleted.push(href);
			fake.store.delete(href);
		}
	};
});

import { CalDAVError } from './caldav';
import { expandToInstances, parseIcs } from './ics';
import { importInvitation, mergeOccurrence, summarizeInvitation } from './imip';

const USER = 'me@example.test';
const HREF = '/dav/cal/me%40example.test/default/sync-1.ics';
const auth = { accountId: 'jmap' } as AuthState;

const berlinTz = [
	'BEGIN:VTIMEZONE', 'TZID:Europe/Berlin', 'BEGIN:STANDARD', 'DTSTART:19701025T030000', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'END:STANDARD', 'END:VTIMEZONE'
].join('\r\n');
const calendar = (method: string | null, ...parts: string[]) =>
	['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//EN', ...(method ? [`METHOD:${method}`] : []), ...parts, 'END:VCALENDAR'].join('\r\n') + '\r\n';
const vevent = (...props: string[]) =>
	['BEGIN:VEVENT', 'DTSTAMP:20261001T000000Z', 'ORGANIZER;CN=Boss:mailto:boss@example.test', `ATTENDEE;PARTSTAT=ACCEPTED:mailto:${USER}`, ...props, 'END:VEVENT'].join('\r\n');

// The weekly sync as it sits on the user's calendar (accepted, with an X-prop another client wrote).
const STORED = calendar(
	null,
	berlinTz,
	vevent('UID:sync-1', 'DTSTART;TZID=Europe/Berlin:20261103T090000', 'DTEND;TZID=Europe/Berlin:20261103T100000', 'RRULE:FREQ=WEEKLY;BYDAY=TU', 'SUMMARY:Weekly sync', 'X-OTHER-CLIENT:kept')
);
// The organizer moves Nov 10 to 14:00 …
const MOVED = calendar(
	'REQUEST',
	berlinTz,
	vevent('UID:sync-1', 'RECURRENCE-ID;TZID=Europe/Berlin:20261110T090000', 'DTSTART;TZID=Europe/Berlin:20261110T140000', 'DTEND;TZID=Europe/Berlin:20261110T150000', 'SUMMARY:Weekly sync (moved)', 'SEQUENCE:1')
);
// … and later cancels Nov 17, writing the RECURRENCE-ID in UTC.
const CANCELLED = calendar(
	'CANCEL',
	vevent('UID:sync-1', 'RECURRENCE-ID:20261117T080000Z', 'DTSTART;TZID=Europe/Berlin:20261117T090000', 'DTEND;TZID=Europe/Berlin:20261117T100000', 'SUMMARY:Weekly sync', 'STATUS:CANCELLED', 'SEQUENCE:2')
);

const starts = (ics: string) =>
	expandToInstances(parseIcs(ics), 'i', 'c', Date.UTC(2026, 10, 1), Date.UTC(2026, 11, 1)).map((i) => `${i.start.slice(0, 16)} ${i.title}`);

beforeEach(() => {
	fake.store.clear();
	fake.puts.length = 0;
	fake.deleted.length = 0;
	fake.store.set(HREF, { ics: STORED, etag: 'etag-1' });
});

describe('summarizeInvitation', () => {
	it('says which occurrence an override-only file is about', () => {
		expect(summarizeInvitation(CANCELLED, USER)).toMatchObject({ uid: 'sync-1', method: 'CANCEL', recurrenceId: '2026-11-17T08:00:00' });
		expect(summarizeInvitation(MOVED, USER)).toMatchObject({ method: 'REQUEST', recurrenceId: '2026-11-10T09:00:00' });
		expect(summarizeInvitation(STORED, USER)?.recurrenceId).toBeNull();
	});
});

describe('mergeOccurrence', () => {
	it('a moved occurrence becomes an override of the stored series, byte-preserving the rest', () => {
		const merged = mergeOccurrence(STORED, MOVED, 'REQUEST')!;
		expect(merged).toContain('X-OTHER-CLIENT:kept');
		expect(merged).toContain('RRULE:FREQ=WEEKLY;BYDAY=TU');
		expect(merged.match(/BEGIN:VTIMEZONE/g)).toHaveLength(1);
		expect(starts(merged)).toEqual([
			'2026-11-03T08:00 Weekly sync',
			'2026-11-10T13:00 Weekly sync (moved)',
			'2026-11-17T08:00 Weekly sync',
			'2026-11-24T08:00 Weekly sync'
		]);
	});

	it('a second update to the same occurrence replaces the first', () => {
		const once = mergeOccurrence(STORED, MOVED, 'REQUEST')!;
		const twice = mergeOccurrence(once, MOVED.replace('T140000', 'T160000').replace('T150000', 'T170000'), 'REQUEST')!;
		expect(twice.match(/RECURRENCE-ID/g)).toHaveLength(1);
		expect(starts(twice)).toContain('2026-11-10T15:00 Weekly sync (moved)');
	});

	it('a cancelled occurrence becomes an EXDATE on the master, in the zone the organizer wrote', () => {
		const merged = mergeOccurrence(mergeOccurrence(STORED, MOVED, 'REQUEST')!, CANCELLED, 'CANCEL')!;
		expect(merged).toContain('EXDATE:20261117T080000Z');
		expect(merged.match(/RECURRENCE-ID/g)).toHaveLength(1);
		expect(starts(merged)).toEqual(['2026-11-03T08:00 Weekly sync', '2026-11-10T13:00 Weekly sync (moved)', '2026-11-24T08:00 Weekly sync']);
	});

	it('has nothing to fold into when the stored copy has no master', () => {
		expect(mergeOccurrence(MOVED, CANCELLED, 'CANCEL')).toBeNull();
	});
});

describe('importInvitation', () => {
	it('folds an occurrence update into the stored series with a conditional write', async () => {
		await importInvitation(auth, USER, MOVED, 'default', 'ACCEPTED');
		expect(fake.puts).toHaveLength(1);
		expect(fake.puts[0].etag).toBe('etag-1');
		expect(starts(fake.puts[0].ics)).toHaveLength(4);
		expect(fake.puts[0].ics).toContain('RRULE:FREQ=WEEKLY;BYDAY=TU');
	});

	it('removes just the cancelled occurrence from the stored series', async () => {
		await importInvitation(auth, USER, CANCELLED, 'default', null);
		expect(fake.deleted).toEqual([]);
		expect(starts(fake.puts[0].ics)).toEqual(['2026-11-03T08:00 Weekly sync', '2026-11-10T08:00 Weekly sync', '2026-11-24T08:00 Weekly sync']);
	});

	it('refuses to cancel an occurrence of a series that is not on the calendar', async () => {
		fake.store.clear();
		await expect(importInvitation(auth, USER, CANCELLED, 'default', null)).rejects.toMatchObject({ status: 404 });
		expect(fake.puts).toEqual([]);
		expect(CalDAVError).toBeDefined();
	});

	it('still stores an occurrence-only invitation for a series it does not hold, and a full one unconditionally', async () => {
		fake.store.clear();
		await importInvitation(auth, USER, MOVED, 'default', 'ACCEPTED');
		expect(fake.puts[0].etag).toBeUndefined();
		expect(fake.puts[0].ics).not.toMatch(/^METHOD/m);

		await importInvitation(auth, USER, STORED.replace('PRODID:-//Test//EN', 'PRODID:-//Test//EN\r\nMETHOD:REQUEST'), 'default', 'TENTATIVE');
		expect(fake.puts[1].etag).toBeUndefined();
		expect(fake.puts[1].ics).toContain('PARTSTAT=TENTATIVE');
	});
});
