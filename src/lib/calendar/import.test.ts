import { describe, expect, it } from 'vitest';
import { readIcsFile } from './import';

const tz = [
	'BEGIN:VTIMEZONE',
	'TZID:Europe/Berlin',
	'BEGIN:STANDARD',
	'DTSTART:19701025T030000',
	'TZOFFSETFROM:+0200',
	'TZOFFSETTO:+0100',
	'END:STANDARD',
	'END:VTIMEZONE'
];

function calendar(...blocks: string[][]): string {
	return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//EN', 'METHOD:PUBLISH', ...blocks.flat(), 'END:VCALENDAR'].join('\r\n');
}

function vevent(uid: string | null, summary: string, extra: string[] = []): string[] {
	return [
		'BEGIN:VEVENT',
		...(uid ? [`UID:${uid}`] : []),
		'DTSTAMP:20261001T000000Z',
		'DTSTART;TZID=Europe/Berlin:20261103T090000',
		'DTEND;TZID=Europe/Berlin:20261103T100000',
		`SUMMARY:${summary}`,
		...extra,
		'END:VEVENT'
	];
}

describe('readIcsFile', () => {
	it('lists one preview row per UID, named by the series master', () => {
		const override = [
			'BEGIN:VEVENT',
			'UID:series',
			'RECURRENCE-ID;TZID=Europe/Berlin:20261110T090000',
			'DTSTART;TZID=Europe/Berlin:20261110T110000',
			'SUMMARY:Moved standup',
			'END:VEVENT'
		];
		const file = readIcsFile(calendar(tz, override, vevent('series', 'Standup', ['RRULE:FREQ=WEEKLY'])));
		expect(file.events).toHaveLength(1);
		expect(file.events[0].title).toBe('Standup');
		expect(file.events[0].start?.getDate()).toBe(3);
		expect(file.batches).toHaveLength(1);
		expect(file.batches[0].count).toBe(1);
		expect(file.batches[0].ics).toContain('Moved standup');
		expect(file.batches[0].ics).toContain('TZID:Europe/Berlin');
	});

	it('unfolds and unescapes titles, and ignores alarm properties', () => {
		const ev = vevent('a', 'Lunch\\, then', [
			' a walk',
			'BEGIN:VALARM',
			'ACTION:DISPLAY',
			'SUMMARY:Alarm text',
			'TRIGGER:-PT10M',
			'END:VALARM'
		]);
		const file = readIcsFile(calendar(ev));
		expect(file.events[0].title).toBe('Lunch, thena walk');
	});

	it('keeps events without a UID apart and skips other components', () => {
		const todo = ['BEGIN:VTODO', 'UID:t1', 'SUMMARY:Task', 'END:VTODO'];
		const file = readIcsFile(calendar(vevent(null, 'One'), vevent(null, 'Two'), todo));
		expect(file.events.map((e) => e.title)).toEqual(['One', 'Two']);
		expect(file.skipped).toBe(1);
	});

	it('reads all-day and UTC starts', () => {
		const allDay = ['BEGIN:VEVENT', 'UID:d', 'DTSTART;VALUE=DATE:20261224', 'SUMMARY:Eve', 'END:VEVENT'];
		const utc = ['BEGIN:VEVENT', 'UID:u', 'DTSTART:20261224T120000Z', 'SUMMARY:Noon', 'END:VEVENT'];
		const file = readIcsFile(calendar(allDay, utc));
		expect(file.events[0].start).toEqual(new Date(2026, 11, 24));
		expect(file.events[1].start?.getTime()).toBe(Date.UTC(2026, 11, 24, 12));
	});

	it('cuts large files into batches that each carry the time zones', () => {
		const events = Array.from({ length: 30 }, (_, i) => vevent(`e${i}`, `Event ${i}`, [`DESCRIPTION:${'x'.repeat(200)}`]));
		const file = readIcsFile(calendar(tz, ...events), 2_000);
		expect(file.batches.length).toBeGreaterThan(1);
		expect(file.batches.reduce((n, b) => n + b.count, 0)).toBe(30);
		for (const batch of file.batches) {
			expect(batch.ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
			expect(batch.ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
			expect(batch.ics).toContain('BEGIN:VTIMEZONE');
			expect(batch.ics).not.toContain('METHOD:');
		}
	});

	it('caps the number of events per batch', () => {
		const events = Array.from({ length: 450 }, (_, i) => vevent(`e${i}`, `E${i}`));
		const file = readIcsFile(calendar(...events));
		expect(file.batches.map((b) => b.count)).toEqual([200, 200, 50]);
	});

	it('rejects files that are not calendars', () => {
		expect(() => readIcsFile('BEGIN:VCARD\r\nFN:Ada\r\nEND:VCARD')).toThrow();
	});
});
