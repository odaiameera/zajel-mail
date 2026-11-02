import { parseWallClock, utcToWallClock, wallClockToUtc } from '$lib/server/calendar/tz';

/**
 * When a job runs. A small set of shapes rather than raw cron: easy to
 * check, easy to show on a card, and never more often than hourly.
 */

export type JobSchedule =
	| { kind: 'once'; at: string } // local "YYYY-MM-DDTHH:mm"
	| { kind: 'hourly' }
	| { kind: 'daily' | 'weekdays'; at: string } // local "HH:mm"; weekdays = Monday to Friday
	| { kind: 'days'; at: string; days: number[] } // the working week as the user keeps it, 0 = Sunday
	| { kind: 'weekly'; at: string; day: number }; // 0 = Sunday

const HH_MM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const SHORT_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON_TO_FRI = [1, 2, 3, 4, 5];

const isDay = (day: unknown): day is number => Number.isInteger(day) && (day as number) >= 0 && (day as number) <= 6;

export function parseSchedule(raw: unknown): JobSchedule | null {
	const s = (raw ?? {}) as Record<string, unknown>;
	const at = typeof s.at === 'string' ? s.at.trim() : '';
	switch (s.kind) {
		case 'once':
			return parseWallClock(at) ? { kind: 'once', at } : null;
		case 'hourly':
			return { kind: 'hourly' };
		case 'daily':
		case 'weekdays':
			return HH_MM.test(at) ? { kind: s.kind, at } : null;
		case 'days': {
			const days: unknown[] = Array.isArray(s.days) ? s.days : [];
			if (!HH_MM.test(at) || days.length === 0 || !days.every(isDay)) return null;
			return { kind: 'days', at, days: [...new Set(days)].sort((a, b) => a - b) };
		}
		case 'weekly': {
			const day = Number(s.day);
			return HH_MM.test(at) && isDay(day) ? { kind: 'weekly', at, day } : null;
		}
		default:
			return null;
	}
}

function runsOn(schedule: JobSchedule, weekday: number): boolean {
	switch (schedule.kind) {
		case 'weekdays':
			return MON_TO_FRI.includes(weekday);
		case 'days':
			return schedule.days.includes(weekday);
		case 'weekly':
			return weekday === schedule.day;
		default:
			return true;
	}
}

/** The first run strictly after `afterMs`, or null when a one-off is past. */
export function nextRun(schedule: JobSchedule, timeZone: string, afterMs: number): number | null {
	if (schedule.kind === 'once') {
		const wall = parseWallClock(schedule.at);
		const at = wall ? wallClockToUtc(wall, timeZone) : NaN;
		return at > afterMs ? at : null;
	}
	if (schedule.kind === 'hourly') {
		return (Math.floor(afterMs / 3_600_000) + 1) * 3_600_000;
	}
	const [hour, minute] = schedule.at.split(':').map(Number);
	const today = utcToWallClock(afterMs, timeZone);
	for (let offset = 0; offset <= 8; offset += 1) {
		const date = new Date(Date.UTC(today.year, today.month - 1, today.day + offset));
		if (!runsOn(schedule, date.getUTCDay())) continue;
		const at = wallClockToUtc(
			{ year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), hour, minute, second: 0 },
			timeZone
		);
		if (at > afterMs) return at;
	}
	return null;
}

/**
 * The days by name, so the confirmation card shows which ones: "Sun–Thu"
 * for a run of three or more (wrapping past Saturday), else a list.
 */
function dayRange(days: number[]): string {
	if (days.length === 7) return 'Every day';
	if (days.length === 1) return `Every ${DAYS[days[0]]}`;
	const set = new Set(days);
	const starts = days.filter((d) => !set.has((d + 6) % 7));
	if (days.length >= 3 && starts.length === 1) {
		const end = (starts[0] + days.length - 1) % 7;
		return `${SHORT_DAYS[starts[0]]}–${SHORT_DAYS[end]}`;
	}
	return days.map((d) => SHORT_DAYS[d]).join(', ');
}

export function describeSchedule(schedule: JobSchedule, timeZone: string): string {
	switch (schedule.kind) {
		case 'once':
			return `Once, ${schedule.at.replace('T', ' ')} (${timeZone})`;
		case 'hourly':
			return 'Every hour';
		case 'daily':
			return `Every day at ${schedule.at} (${timeZone})`;
		case 'weekdays':
			return `${dayRange(MON_TO_FRI)} at ${schedule.at} (${timeZone})`;
		case 'days':
			return `${dayRange(schedule.days)} at ${schedule.at} (${timeZone})`;
		case 'weekly':
			return `Every ${DAYS[schedule.day]} at ${schedule.at} (${timeZone})`;
	}
}
