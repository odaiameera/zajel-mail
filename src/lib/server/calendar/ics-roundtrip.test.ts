import { describe, expect, it } from 'vitest';
import { buildIcs, expandToInstances, parseIcs, payloadToData } from './ics';
import type { EventWritePayload } from '$lib/calendar/types';

/**
 * Round trips through parse → build → expand that real calendars exercise,
 * ported from the old tests/ics-qa.mjs probes. Zone-specific UNTIL,
 * EXDATE and RECURRENCE-ID rewriting live in ics.test.ts, and series edits
 * (keeping a rule the presets can't express) in series.test.ts.
 */

const wrap = (...lines: string[]) =>
	['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//EN', ...lines, 'END:VCALENDAR'].join('\r\n') + '\r\n';
const vevent = (...props: string[]) => ['BEGIN:VEVENT', 'DTSTAMP:20260601T000000Z', ...props, 'END:VEVENT'].join('\r\n');
const line = (ics: string, name: string) => ics.split('\r\n').find((l) => l.startsWith(name)) ?? '';

const JUN = Date.UTC(2026, 5, 1);
const JUL = Date.UTC(2026, 6, 1);
const AUG = Date.UTC(2026, 7, 1);

function rebuild(ics: string): string {
	const parsed = parseIcs(ics);
	return buildIcs(parsed.master!, parsed.overrides);
}

function starts(ics: string, from: number, to: number): string[] {
	return expandToInstances(parseIcs(ics), 'id', 'cal', from, to).map((i) => i.start);
}

describe('rebuilding an event keeps it valid', () => {
	it('writes CREATED as an ICS date-time', () => {
		const ics = wrap(vevent('UID:p1', 'CREATED:20250101T120000Z', 'DTSTART:20260615T100000Z', 'DTEND:20260615T110000Z', 'SUMMARY:x'));
		expect(line(rebuild(ics), 'CREATED')).toMatch(/^CREATED:\d{8}T\d{6}Z?$/);
	});

	it('keeps an all-day UNTIL a DATE, and the rebuilt series still expands', () => {
		const ics = wrap(
			vevent('UID:p2', 'DTSTART;VALUE=DATE:20260601', 'DTEND;VALUE=DATE:20260602', 'RRULE:FREQ=DAILY;UNTIL=20260610', 'SUMMARY:x')
		);
		const rebuilt = rebuild(ics);
		expect(line(rebuilt, 'RRULE')).toMatch(/UNTIL=\d{8}(;|$)/);
		expect(starts(rebuilt, JUN, JUL)).toHaveLength(10);
	});

	it('keeps rule parts it does not model, such as BYSETPOS, with the same occurrences', () => {
		const ics = wrap(
			vevent(
				'UID:p3',
				'DTSTART;TZID=Europe/Berlin:20260129T090000',
				'DTEND;TZID=Europe/Berlin:20260129T100000',
				'RRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1',
				'SUMMARY:last workday'
			)
		);
		const rebuilt = rebuild(ics);
		expect(line(rebuilt, 'RRULE')).toContain('BYSETPOS=-1');
		expect(starts(rebuilt, JUN, AUG)).toEqual(starts(ics, JUN, AUG));
		expect(starts(ics, JUN, AUG)).toHaveLength(2);
	});

	it('keeps a Google-style timed UNTIL series at the same length', () => {
		const ics = wrap(
			vevent(
				'UID:p6',
				'DTSTART;TZID=Europe/Berlin:20260601T090000',
				'DTEND;TZID=Europe/Berlin:20260601T100000',
				'RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20260720T065959Z',
				'SUMMARY:weekly'
			)
		);
		const before = starts(ics, JUN, Date.UTC(2026, 7, 31));
		expect(before).toHaveLength(7);
		expect(starts(rebuild(ics), JUN, Date.UTC(2026, 7, 31))).toEqual(before);
	});
});

describe('expansion', () => {
	it('shows a daily event from 2020 in June 2026', () => {
		const ics = wrap(
			vevent('UID:p4', 'DTSTART;TZID=Europe/Berlin:20200106T090000', 'DTEND;TZID=Europe/Berlin:20200106T091500', 'RRULE:FREQ=DAILY', 'SUMMARY:standup')
		);
		expect(starts(ics, JUN, JUL)).toHaveLength(30);
	});

	it.each([
		['RDATE', 'RDATE::2'],
		['EXDATE', 'EXDATE:20260105T090000Z,:2'],
		['DURATION', 'DURATION:PT:2H'],
		['COUNT', 'RRULE:FREQ=DAILY;COUNT='],
		['TRIGGER', 'BEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:-PT:2M\r\nEND:VALARM']
	])('a malformed %s neither throws nor hides the event', (_name, prop) => {
		const ics = wrap(vevent('UID:bad', 'DTSTART:20260115T090000Z', 'DTEND:20260115T100000Z', 'SUMMARY:quirky', prop));
		const found = starts(ics, Date.UTC(2026, 0, 1), Date.UTC(2026, 1, 1));
		expect(found.some((s) => s.startsWith('2026-01-15'))).toBe(true);
	});
});

describe('events written from the editor', () => {
	const payload = (p: Partial<EventWritePayload>): EventWritePayload =>
		({
			calendarId: 'cal',
			title: 'x',
			allDay: false,
			start: '',
			end: '',
			timeZone: 'UTC',
			description: '',
			location: '',
			rrule: null,
			alarms: [],
			attendees: [],
			status: 'confirmed',
			...p
		}) as EventWritePayload;

	it('writes an all-day weekly UNTIL in DATE form, including the last Monday', () => {
		const data = payloadToData(
			payload({
				allDay: true,
				start: '2026-06-01',
				end: '2026-06-02',
				rrule: { freq: 'WEEKLY', interval: 1, byDay: ['MO'], until: '2026-07-20' } as EventWritePayload['rrule']
			}),
			'p8'
		)!;
		expect(data.rruleRaw).toBe('FREQ=WEEKLY;BYDAY=MO;UNTIL=20260720');
		const found = expandToInstances({ master: data, overrides: [], method: null } as never, 'id', 'cal', JUN, AUG).map((i) => i.start);
		expect(found).toHaveLength(8);
		expect(found.at(-1)).toMatch(/^2026-07-20/);
	});

	it('moves one occurrence from a browser in another zone, keeping the master zone on RECURRENCE-ID', () => {
		const ics = wrap(
			vevent(
				'UID:p9',
				'DTSTART;TZID=America/New_York:20260601T090000',
				'DTEND;TZID=America/New_York:20260601T100000',
				'RRULE:FREQ=DAILY;COUNT=5',
				'SUMMARY:ny series'
			)
		);
		const master = parseIcs(ics).master!;
		const override = payloadToData(
			payload({ title: 'ny series', start: '2026-06-03T17:00', end: '2026-06-03T18:00', timeZone: 'Europe/Berlin' }),
			master.uid,
			{ recurrenceId: '20260603T090000', ridTzid: master.tzid, ridIsDate: master.allDay, sequence: master.sequence, organizer: master.organizer }
		)!;
		override.rrule = null;
		override.rruleRaw = null;

		const rebuilt = buildIcs(master, [override]);
		expect(line(rebuilt, 'RECURRENCE-ID')).toContain('TZID=America/New_York');
		const found = starts(rebuilt, JUN, Date.UTC(2026, 5, 10));
		expect(found).toHaveLength(5);
		expect(found).toContain('2026-06-03T15:00:00.000Z');
	});
});
