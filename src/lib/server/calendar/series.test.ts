import { describe, expect, it } from 'vitest';
import type { EventWritePayload } from '$lib/calendar/types';
import { buildIcs, expandToInstances, parseIcs, payloadToData, type VEventData } from './ics';
import { applySeriesEdit, shiftRRuleAnchors, tailRRule } from './series';

const wrap = (...lines: string[]) =>
	['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//EN', ...lines, 'END:VCALENDAR'].join('\r\n') + '\r\n';
const vevent = (...props: string[]) => ['BEGIN:VEVENT', 'DTSTAMP:20260101T000000Z', ...props, 'END:VEVENT'].join('\r\n');

// A weekly Monday standup since Nov 2 2026 in Riyadh, with Nov 9 skipped and
// Nov 16 moved to 11:00 and retitled.
const SERIES = wrap(
	vevent(
		'UID:p1',
		'DTSTART;TZID=Asia/Riyadh:20261102T090000',
		'DTEND;TZID=Asia/Riyadh:20261102T093000',
		'RRULE:FREQ=WEEKLY;BYDAY=MO',
		'EXDATE;TZID=Asia/Riyadh:20261109T090000',
		'SUMMARY:Standup',
		'TRANSP:TRANSPARENT'
	),
	vevent(
		'UID:p1',
		'RECURRENCE-ID;TZID=Asia/Riyadh:20261116T090000',
		'DTSTART;TZID=Asia/Riyadh:20261116T110000',
		'DTEND;TZID=Asia/Riyadh:20261116T120000',
		'SUMMARY:Standup (moved)'
	)
);

const wc = (y: number, m: number, d: number, h = 0, mi = 0) => ({ year: y, month: m, day: d, hour: h, minute: mi, second: 0 });

/** The payload the modal or a drag sends for one occurrence, as the browser in `timeZone` sees it. */
function payloadFor(start: string, end: string, extra: Partial<EventWritePayload> = {}): EventWritePayload {
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

function edit(ics: string, payload: EventWritePayload, recurrenceId: string | null) {
	const parsed = parseIcs(ics);
	const master = parsed.master!;
	const edited = payloadToData(payload, master.uid, { sequence: master.sequence + 1, organizer: master.organizer })!;
	edited.transp = master.transp;
	const out = applySeriesEdit(master, parsed.overrides, edited, payload, recurrenceId);
	return { ...out, ics: buildIcs(out.master, out.overrides) };
}

const dateLines = (ics: string) => ics.split('\r\n').filter((l) => /^(DTSTART|DTEND|RRULE|EXDATE|RDATE|RECURRENCE-ID)/.test(l));
const starts = (ics: string, from: number, to: number) => expandToInstances(parseIcs(ics), 'i', 'c', from, to).map((i) => i.start.slice(0, 16));

describe('applySeriesEdit', () => {
	it('a title edit from a later occurrence leaves every date line of the series byte-identical', () => {
		const { ics, master, overrides } = edit(SERIES, payloadFor('2026-11-30T09:00', '2026-11-30T09:30', { title: 'Daily sync' }), '2026-11-30T09:00:00');
		expect(dateLines(ics)).toEqual(dateLines(SERIES));
		expect(master.summary).toBe('Daily sync');
		expect(overrides[0].summary).toBe('Daily sync');
		expect(master.transp).toBe('TRANSPARENT');
		expect(starts(ics, Date.UTC(2026, 10, 1), Date.UTC(2026, 11, 31))).toEqual(
			starts(SERIES, Date.UTC(2026, 10, 1), Date.UTC(2026, 11, 31))
		);
	});

	it('moving one occurrence an hour later moves the series and every exception by an hour', () => {
		const { ics } = edit(SERIES, payloadFor('2026-11-30T10:00', '2026-11-30T10:30'), '2026-11-30T09:00:00');
		expect(dateLines(ics)).toEqual([
			'DTSTART;TZID=Asia/Riyadh:20261102T100000',
			'DTEND;TZID=Asia/Riyadh:20261102T103000',
			'RRULE:FREQ=WEEKLY;BYDAY=MO',
			'EXDATE;TZID=Asia/Riyadh:20261109T100000',
			'RECURRENCE-ID;TZID=Asia/Riyadh:20261116T100000',
			'DTSTART;TZID=Asia/Riyadh:20261116T120000',
			'DTEND;TZID=Asia/Riyadh:20261116T130000'
		]);
	});

	it('a browser in another zone that changes nothing changes nothing', () => {
		// 09:00 Riyadh on Nov 30 is 07:00 in Berlin; an untouched edit from Berlin sends that.
		const { ics } = edit(SERIES, payloadFor('2026-11-30T07:00', '2026-11-30T07:30', { timeZone: 'Europe/Berlin', title: 'Standup!' }), '2026-11-30T09:00:00');
		expect(dateLines(ics)).toEqual(dateLines(SERIES));
	});

	it('dragging the series to another weekday rotates BYDAY and keeps the exceptions attached', () => {
		const { ics } = edit(SERIES, payloadFor('2026-12-01T09:00', '2026-12-01T09:30'), '2026-11-30T09:00:00');
		expect(dateLines(ics)).toEqual([
			'DTSTART;TZID=Asia/Riyadh:20261103T090000',
			'DTEND;TZID=Asia/Riyadh:20261103T093000',
			'RRULE:FREQ=WEEKLY;BYDAY=TU',
			'EXDATE;TZID=Asia/Riyadh:20261110T090000',
			'RECURRENCE-ID;TZID=Asia/Riyadh:20261117T090000',
			'DTSTART;TZID=Asia/Riyadh:20261117T110000',
			'DTEND;TZID=Asia/Riyadh:20261117T120000'
		]);
		expect(starts(ics, Date.UTC(2026, 10, 1), Date.UTC(2026, 11, 1))).toEqual([
			'2026-11-03T06:00',
			'2026-11-17T08:00',
			'2026-11-24T06:00'
		]);
	});

	it('keeps a rule the presets cannot express when the recurrence was not touched', () => {
		const thanksgiving = wrap(
			vevent('UID:tg', 'DTSTART;VALUE=DATE:20261126', 'DTEND;VALUE=DATE:20261127', 'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=4TH', 'SUMMARY:Thanksgiving')
		);
		// The modal's 'yearly' preset would send FREQ=YEARLY.
		const payload = payloadFor('2026-11-26', '2026-11-27', { allDay: true, rrule: { freq: 'YEARLY', interval: 1 }, title: 'Thanksgiving dinner' });
		const { ics } = edit(thanksgiving, payload, '2026-11-26');
		expect(ics).toContain('RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=4TH');
		expect(starts(ics, Date.UTC(2027, 0, 1), Date.UTC(2028, 0, 1))).toEqual(['2027-11-25']);
	});

	it('rebuilds the rule when the recurrence was changed, keeping only overrides that still fall on an occurrence', () => {
		// Every two weeks from Nov 2: Nov 16 is still an occurrence, Nov 9 is not.
		const biweekly = payloadFor('2026-11-02T09:00', '2026-11-02T09:30', {
			rrule: { freq: 'WEEKLY', interval: 2, byDay: ['MO'] },
			keepRecurrence: false
		});
		const { ics, overrides } = edit(SERIES, biweekly, '2026-11-02T09:00:00');
		expect(ics).toContain('RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO');
		expect(overrides.map((o) => o.recurrenceId)).toEqual(['20261116T090000']);

		// Every three weeks from Nov 2 (Nov 2, 23, Dec 14): Nov 16 is off-cycle, so its override is dropped
		// rather than left as a stray event. The series anchor itself never moves for a rule change.
		const every3 = payloadFor('2026-11-30T09:00', '2026-11-30T09:30', { rrule: { freq: 'WEEKLY', interval: 3, byDay: ['MO'] }, keepRecurrence: false });
		const sparse = edit(SERIES, every3, '2026-11-30T09:00:00');
		expect(sparse.master.startWall).toEqual(wc(2026, 11, 2, 9, 0));
		expect(sparse.overrides).toEqual([]);
	});

	it('edits made from a moved occurrence apply only what changed on it', () => {
		// The Nov 16 override runs 11:00–12:00 and is titled "Standup (moved)". Retitle it with "All events".
		const payload = payloadFor('2026-11-16T11:00', '2026-11-16T12:00', { title: 'Team sync' });
		const { master, overrides } = edit(SERIES, payload, '2026-11-16T09:00:00');
		expect(master.summary).toBe('Team sync');
		expect(overrides[0].summary).toBe('Team sync');
		// Its longer duration and later start were not edits, so the series keeps 09:00–09:30.
		expect(master.startWall).toEqual(wc(2026, 11, 2, 9, 0));
		expect(master.durationMs).toBe(30 * 60000);
		expect(overrides[0].startWall).toEqual(wc(2026, 11, 16, 11, 0));
	});

	it('resets exceptions only when they cannot carry over: an all-day switch or no recurrence', () => {
		const allDay = payloadFor('2026-11-30', '2026-12-01', { allDay: true });
		const switched = edit(SERIES, allDay, '2026-11-30T09:00:00');
		expect(switched.master.startWall).toEqual(wc(2026, 11, 2));
		expect(switched.master.allDay).toBe(true);
		expect(switched.overrides).toEqual([]);

		const single = payloadFor('2026-11-30T09:00', '2026-11-30T09:30', { rrule: null, keepRecurrence: false });
		const flattened = edit(SERIES, single, '2026-11-30T09:00:00');
		expect(flattened.master.rruleRaw).toBeNull();
		expect(flattened.master.exdates).toEqual([]);
		expect(flattened.overrides).toEqual([]);
	});
});

describe('shiftRRuleAnchors', () => {
	const mon = wc(2026, 11, 2);
	it('rotates a weekly BYDAY set by the weekday difference', () => {
		expect(shiftRRuleAnchors('FREQ=WEEKLY;BYDAY=MO,WE,FR', mon, wc(2026, 11, 3))).toBe('FREQ=WEEKLY;BYDAY=TU,TH,SA');
		expect(shiftRRuleAnchors('FREQ=WEEKLY;BYDAY=MO;WKST=SU', mon, wc(2026, 11, 8))).toBe('FREQ=WEEKLY;BYDAY=SU;WKST=SU');
	});
	it('moves a monthly weekday anchor, ordinal included, and a month-day anchor', () => {
		expect(shiftRRuleAnchors('FREQ=MONTHLY;BYDAY=1MO', mon, wc(2026, 11, 3))).toBe('FREQ=MONTHLY;BYDAY=1TU');
		expect(shiftRRuleAnchors('FREQ=MONTHLY;BYDAY=1MO', mon, wc(2026, 11, 9))).toBe('FREQ=MONTHLY;BYDAY=2MO');
		expect(shiftRRuleAnchors('FREQ=MONTHLY;BYDAY=-1MO', wc(2026, 11, 30), wc(2026, 12, 1))).toBe('FREQ=MONTHLY;BYDAY=-1TU');
		expect(shiftRRuleAnchors('FREQ=MONTHLY;BYMONTHDAY=2', mon, wc(2026, 11, 3))).toBe('FREQ=MONTHLY;BYMONTHDAY=3');
		expect(shiftRRuleAnchors('FREQ=YEARLY;BYMONTH=11;BYDAY=4TH', wc(2026, 11, 26), wc(2026, 11, 27))).toBe('FREQ=YEARLY;BYMONTH=11;BYDAY=4FR');
	});
	it('leaves a daily weekday filter and time-only moves alone', () => {
		expect(shiftRRuleAnchors('FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR', mon, wc(2026, 11, 3))).toBe('FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR');
		expect(shiftRRuleAnchors('FREQ=WEEKLY;BYDAY=MO', mon, wc(2026, 11, 2, 10))).toBe('FREQ=WEEKLY;BYDAY=MO');
	});
});

describe('tailRRule', () => {
	it('gives the tail of a COUNT series what the head has not used, EXDATEs included', () => {
		const master = parseIcs(wrap(vevent('UID:c', 'DTSTART;TZID=Asia/Riyadh:20261102T090000', 'DTEND;TZID=Asia/Riyadh:20261102T093000', 'RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=10', 'EXDATE;TZID=Asia/Riyadh:20261109T090000'))).master as VEventData;
		// ical.js serialises the stored rule as FREQ;COUNT;BYDAY — only the number changes.
		expect(tailRRule(master, wc(2026, 11, 23, 9))).toBe('FREQ=WEEKLY;COUNT=7;BYDAY=MO');
		expect(tailRRule({ ...master, rruleRaw: 'FREQ=WEEKLY;BYDAY=MO' }, wc(2026, 11, 23, 9))).toBe('FREQ=WEEKLY;BYDAY=MO');
	});
});
