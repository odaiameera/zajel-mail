import { describe, expect, it } from 'vitest';
import { splitIcsForImport } from './import';
import { parseIcs } from './ics';

const berlin = [
	'BEGIN:VTIMEZONE',
	'TZID:Europe/Berlin',
	'BEGIN:STANDARD',
	'DTSTART:19701025T030000',
	'TZOFFSETFROM:+0200',
	'TZOFFSETTO:+0100',
	'END:STANDARD',
	'END:VTIMEZONE'
];
const tokyo = [
	'BEGIN:VTIMEZONE',
	'TZID:Asia/Tokyo',
	'BEGIN:STANDARD',
	'DTSTART:19700101T000000',
	'TZOFFSETFROM:+0900',
	'TZOFFSETTO:+0900',
	'END:STANDARD',
	'END:VTIMEZONE'
];

function calendar(...blocks: string[][]): string {
	return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//EN', 'METHOD:REQUEST', ...blocks.flat(), 'END:VCALENDAR'].join('\r\n');
}

describe('splitIcsForImport', () => {
	it('stores one object per UID with only the zones it uses and no METHOD', () => {
		const ics = calendar(
			berlin,
			tokyo,
			[
				'BEGIN:VEVENT', 'UID:series', 'DTSTAMP:20261001T000000Z',
				'DTSTART;TZID=Europe/Berlin:20261103T090000', 'DTEND;TZID=Europe/Berlin:20261103T100000',
				'RRULE:FREQ=WEEKLY', 'SUMMARY:Standup', 'END:VEVENT'
			],
			[
				'BEGIN:VEVENT', 'UID:series', 'DTSTAMP:20261001T000000Z',
				'RECURRENCE-ID;TZID=Europe/Berlin:20261110T090000',
				'DTSTART;TZID=Europe/Berlin:20261110T110000', 'DTEND;TZID=Europe/Berlin:20261110T120000',
				'SUMMARY:Standup (moved)', 'END:VEVENT'
			],
			[
				'BEGIN:VEVENT', 'UID:trip', 'DTSTAMP:20261001T000000Z',
				'DTSTART;VALUE=DATE:20261201', 'DTEND;VALUE=DATE:20261204', 'SUMMARY:Trip', 'END:VEVENT'
			]
		);
		const { objects, invalid } = splitIcsForImport(ics);
		expect(invalid).toBe(0);
		expect(objects.map((o) => o.uid)).toEqual(['series', 'trip']);

		const [series, trip] = objects;
		expect(series.day).toBe('2026-11-03');
		expect(series.ics).toContain('TZID:Europe/Berlin');
		expect(series.ics).not.toContain('Asia/Tokyo');
		expect(series.ics).not.toMatch(/^METHOD/m);
		const parsed = parseIcs(series.ics);
		expect(parsed.master?.summary).toBe('Standup');
		expect(parsed.overrides).toHaveLength(1);

		expect(trip.day).toBe('2026-12-01');
		expect(trip.ics).not.toContain('VTIMEZONE');
	});

	it('gives events without a UID their own', () => {
		const ev = ['BEGIN:VEVENT', 'DTSTART:20261224T120000Z', 'SUMMARY:No uid', 'END:VEVENT'];
		const { objects } = splitIcsForImport(calendar(ev, ev));
		expect(objects).toHaveLength(2);
		expect(objects[0].uid).not.toBe(objects[1].uid);
		expect(parseIcs(objects[0].ics).master?.uid).toBe(objects[0].uid);
	});

	it('refuses text that is not iCalendar', () => {
		expect(() => splitIcsForImport('not a calendar')).toThrow();
	});
});
