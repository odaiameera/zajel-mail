import { afterAll, describe, expect, it } from 'vitest';
import type { EventInstance } from './types';
import { clipToDay, timedEventsByDay } from './layout';

// The grid lays events out in the browser's zone. New York has both DST
// transitions in 2026 (Mar 8 forward, Nov 1 back), which is where elapsed-ms
// arithmetic and wall-clock minutes disagree.
const previousZone = process.env.TZ;
process.env.TZ = 'America/New_York';
afterAll(() => {
	process.env.TZ = previousZone;
});

function event(start: Date, end: Date): EventInstance {
	return {
		id: 'e',
		calendarId: 'c',
		uid: 'u',
		title: 't',
		description: '',
		location: '',
		start: start.toISOString(),
		end: end.toISOString(),
		allDay: false,
		recurring: false,
		recurrenceId: null,
		rrule: null,
		alarms: [],
		status: 'confirmed',
		attendees: [],
		organizer: null,
		timeZone: null
	};
}

describe('clipToDay', () => {
	it('runs in New York time', () => {
		expect(new Date(2026, 10, 1, 0, 30).getTimezoneOffset()).toBe(240); // still EDT
		expect(new Date(2026, 10, 1, 10, 0).getTimezoneOffset()).toBe(300); // EST after the fall-back
	});

	it('draws events at their wall-clock minute on the 25-hour fall-back day', () => {
		const day = new Date(2026, 10, 1);
		expect(clipToDay(event(new Date(2026, 10, 1, 10, 0), new Date(2026, 10, 1, 11, 0)), day)).toEqual({ startMin: 600, endMin: 660 });
		// The last hour of the day exists on the grid, too.
		const late = event(new Date(2026, 10, 1, 23, 30), new Date(2026, 10, 1, 23, 45));
		expect([...timedEventsByDay([late]).keys()]).toEqual(['2026-11-01']);
		expect(clipToDay(late, day)).toEqual({ startMin: 1410, endMin: 1425 });
	});

	it('draws events at their wall-clock minute on the 23-hour spring-forward day', () => {
		const day = new Date(2026, 2, 8);
		expect(clipToDay(event(new Date(2026, 2, 8, 10, 0), new Date(2026, 2, 8, 10, 30)), day)).toEqual({ startMin: 600, endMin: 630 });
	});

	it('gives a zero-length event the 15-minute floor instead of dropping it', () => {
		const at = new Date(2026, 10, 3, 15, 0);
		expect(clipToDay(event(at, at), new Date(2026, 10, 3))).toEqual({ startMin: 900, endMin: 915 });
		const lastMinute = new Date(2026, 10, 3, 23, 55);
		expect(clipToDay(event(lastMinute, lastMinute), new Date(2026, 10, 3))).toEqual({ startMin: 1435, endMin: 1440 });
	});

	it('clips at the day boundaries and skips days the event does not touch', () => {
		const ev = event(new Date(2026, 10, 3, 22, 0), new Date(2026, 10, 4, 0, 0));
		expect(clipToDay(ev, new Date(2026, 10, 3))).toEqual({ startMin: 1320, endMin: 1440 });
		expect(clipToDay(ev, new Date(2026, 10, 4))).toBeNull();
		expect(clipToDay(event(new Date(2026, 10, 3, 9, 0), new Date(2026, 10, 3, 10, 0)), new Date(2026, 10, 4))).toBeNull();
	});
});
