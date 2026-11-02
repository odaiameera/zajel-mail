import { describe, expect, it } from 'vitest';
import { buildIcs, buildRRuleString, expandToInstances, parseIcs, untilValue } from './ics';

const wrap = (...lines: string[]) =>
	['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//EN', ...lines, 'END:VCALENDAR'].join('\r\n') + '\r\n';
const vevent = (...props: string[]) => ['BEGIN:VEVENT', 'DTSTAMP:20260101T000000Z', ...props, 'END:VEVENT'].join('\r\n');

/** Local calendar dates of a series' occurrences inside [from, to). */
function localDays(ics: string, from: number, to: number, zone: string): string[] {
	return expandToInstances(parseIcs(ics), 'id', 'cal', from, to).map((i) =>
		new Date(i.start).toLocaleDateString('sv', { timeZone: zone })
	);
}

const NOV = Date.UTC(2026, 10, 1);
const DEC = Date.UTC(2026, 11, 1);

describe('UNTIL in the series zone', () => {
	it('writes UNTIL as the last second of the day in the series zone, not T235959Z', () => {
		expect(untilValue('2026-11-09', false, 'Asia/Tokyo')).toBe('20261109T145959Z');
		expect(untilValue('2026-11-09', false, 'America/Los_Angeles')).toBe('20261110T075959Z');
		expect(untilValue('2026-11-09', true, 'Asia/Tokyo')).toBe('20261109');
		expect(buildRRuleString({ freq: 'DAILY', interval: 1, until: '2026-11-09' }, false, 'Asia/Tokyo')).toBe(
			'FREQ=DAILY;UNTIL=20261109T145959Z'
		);
	});

	it('a Tokyo morning series ending Nov 9 does not run into Nov 10, and an LA evening one keeps Nov 9', () => {
		const tokyo = wrap(
			vevent('UID:t', 'DTSTART;TZID=Asia/Tokyo:20261103T080000', 'DTEND;TZID=Asia/Tokyo:20261103T090000', `RRULE:FREQ=DAILY;${'UNTIL=' + untilValue('2026-11-09', false, 'Asia/Tokyo')}`)
		);
		expect(localDays(tokyo, NOV, DEC, 'Asia/Tokyo').at(-1)).toBe('2026-11-09');
		expect(localDays(tokyo, NOV, DEC, 'Asia/Tokyo')).toHaveLength(7);

		const la = wrap(
			vevent('UID:l', 'DTSTART;TZID=America/Los_Angeles:20261103T190000', 'DTEND;TZID=America/Los_Angeles:20261103T200000', `RRULE:FREQ=DAILY;${'UNTIL=' + untilValue('2026-11-09', false, 'America/Los_Angeles')}`)
		);
		expect(localDays(la, NOV, DEC, 'America/Los_Angeles').at(-1)).toBe('2026-11-09');
		expect(localDays(la, NOV, DEC, 'America/Los_Angeles')).toHaveLength(7);
	});

	it('reads a UTC UNTIL back as the local day it ends on', () => {
		const la = wrap(
			vevent('UID:l', 'DTSTART;TZID=America/Los_Angeles:20261103T190000', 'DTEND;TZID=America/Los_Angeles:20261103T200000', 'RRULE:FREQ=DAILY;UNTIL=20261110T075959Z')
		);
		expect(parseIcs(la).master?.rrule?.until).toBe('2026-11-09');
	});
});

describe('exceptions written in another zone', () => {
	const berlin = (...extra: string[]) =>
		wrap(
			vevent(
				'UID:x',
				'DTSTART;TZID=Europe/Berlin:20260105T090000',
				'DTEND;TZID=Europe/Berlin:20260105T100000',
				'RRULE:FREQ=DAILY;COUNT=3',
				...extra
			)
		);
	const JAN = Date.UTC(2026, 0, 1);
	const FEB = Date.UTC(2026, 1, 1);

	it('an EXDATE in UTC excludes its occurrence and is rewritten in the series zone', () => {
		const ics = berlin('EXDATE:20260106T080000Z');
		const parsed = parseIcs(ics);
		expect(parsed.master?.exdates).toEqual(['20260106T090000']);
		expect(localDays(ics, JAN, FEB, 'Europe/Berlin')).toEqual(['2026-01-05', '2026-01-07']);
		expect(buildIcs(parsed.master!, [])).toContain('EXDATE;TZID=Europe/Berlin:20260106T090000');
	});

	it('a RECURRENCE-ID in UTC matches its occurrence and is rewritten in the series zone', () => {
		const ics = wrap(
			vevent('UID:x', 'DTSTART;TZID=Europe/Berlin:20260105T090000', 'DTEND;TZID=Europe/Berlin:20260105T100000', 'RRULE:FREQ=DAILY;COUNT=3'),
			vevent('UID:x', 'RECURRENCE-ID:20260106T080000Z', 'DTSTART;TZID=Europe/Berlin:20260106T110000', 'DTEND;TZID=Europe/Berlin:20260106T120000', 'SUMMARY:moved')
		);
		const parsed = parseIcs(ics);
		expect(parsed.overrides[0].recurrenceId).toBe('20260106T090000');
		const instances = expandToInstances(parsed, 'id', 'cal', JAN, FEB);
		expect(instances).toHaveLength(3);
		expect(instances.find((i) => i.title === 'moved')?.start).toBe('2026-01-06T10:00:00.000Z');
		expect(buildIcs(parsed.master!, parsed.overrides)).toContain('RECURRENCE-ID;TZID=Europe/Berlin:20260106T090000');
	});

	it('an all-day series shows a date-time RECURRENCE-ID override once', () => {
		const ics = wrap(
			vevent('UID:a', 'DTSTART;VALUE=DATE:20260105', 'DTEND;VALUE=DATE:20260106', 'RRULE:FREQ=DAILY;COUNT=3', 'SUMMARY:a'),
			vevent('UID:a', 'RECURRENCE-ID:20260106T000000', 'DTSTART;VALUE=DATE:20260106', 'DTEND;VALUE=DATE:20260107', 'SUMMARY:a override')
		);
		const parsed = parseIcs(ics);
		const titles = expandToInstances(parsed, 'id', 'cal', JAN, FEB).map((i) => `${i.start}:${i.title}`);
		expect(titles).toEqual(['2026-01-05:a', '2026-01-06:a override', '2026-01-07:a']);
		expect(buildIcs(parsed.master!, parsed.overrides)).toContain('RECURRENCE-ID;VALUE=DATE:20260106');
	});
});

describe('zones nothing can name', () => {
	const JAN = Date.UTC(2026, 0, 1);
	const FEB = Date.UTC(2026, 1, 1);
	const customZone = [
		'BEGIN:VTIMEZONE',
		'TZID:Customized Time Zone',
		'BEGIN:STANDARD',
		'DTSTART:16010101T000000',
		'TZOFFSETFROM:+0300',
		'TZOFFSETTO:+0300',
		'END:STANDARD',
		'END:VTIMEZONE'
	].join('\r\n');

	it("reads an Outlook 'Customized Time Zone' from its VTIMEZONE and writes it back untouched", () => {
		const ics = wrap(
			customZone,
			vevent('UID:o', 'DTSTART;TZID=Customized Time Zone:20260105T090000', 'DTEND;TZID=Customized Time Zone:20260105T100000', 'SUMMARY:Outlook')
		);
		const parsed = parseIcs(ics);
		expect(expandToInstances(parsed, 'id', 'cal', JAN, FEB).map((i) => i.start)).toEqual(['2026-01-05T06:00:00.000Z']);
		const rebuilt = buildIcs(parsed.master!, parsed.overrides, parsed.timezones);
		expect(rebuilt).toContain('DTSTART;TZID=Customized Time Zone:20260105T090000');
		expect(rebuilt).toContain('TZID:Customized Time Zone');
		// And the rewritten object still means the same instant.
		expect(expandToInstances(parseIcs(rebuilt), 'id', 'cal', JAN, FEB).map((i) => i.start)).toEqual(['2026-01-05T06:00:00.000Z']);
	});

	it('keeps a TZID it cannot resolve rather than rewriting the event in UTC', () => {
		const parsed = parseIcs(wrap(vevent('UID:m', 'DTSTART;TZID=Mars/Olympus:20260105T090000', 'DTEND;TZID=Mars/Olympus:20260105T100000', 'SUMMARY:m')));
		expect(parsed.master?.tzid).toBe('Mars/Olympus');
		expect(buildIcs(parsed.master!, [])).toContain('DTSTART;TZID=Mars/Olympus:20260105T090000');
	});

	it('keeps a floating time floating', () => {
		const parsed = parseIcs(wrap(vevent('UID:f', 'DTSTART:20260105T090000', 'DTEND:20260105T100000', 'SUMMARY:f')));
		expect(expandToInstances(parsed, 'id', 'cal', JAN, FEB)[0].timeZone).toBeNull();
		expect(buildIcs(parsed.master!, [])).toContain('DTSTART:20260105T090000\r\n');
		expect(buildIcs(parsed.master!, [])).not.toContain('DTSTART:20260105T090000Z');
	});
});
