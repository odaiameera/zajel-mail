import { parseWallClock, utcToWallClock, wallClockToUtc } from '$lib/server/calendar/tz';

/**
 * When a job runs. A small set of shapes rather than raw cron: easy to
 * check, easy to show on a card, and never more often than hourly.
 */

export type JobSchedule =
	| { kind: 'once'; at: string } // local "YYYY-MM-DDTHH:mm"
	| { kind: 'hourly' }
	| { kind: 'daily' | 'weekdays'; at: string } // local "HH:mm"
	| { kind: 'weekly'; at: string; day: number }; // 0 = Sunday

const HH_MM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

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
		case 'weekly': {
			const day = Number(s.day);
			return HH_MM.test(at) && Number.isInteger(day) && day >= 0 && day <= 6 ? { kind: 'weekly', at, day } : null;
		}
		default:
			return null;
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
		const weekday = date.getUTCDay();
		if (schedule.kind === 'weekdays' && (weekday === 0 || weekday === 6)) continue;
		if (schedule.kind === 'weekly' && weekday !== schedule.day) continue;
		const at = wallClockToUtc(
			{ year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), hour, minute, second: 0 },
			timeZone
		);
		if (at > afterMs) return at;
	}
	return null;
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
			return `Weekdays at ${schedule.at} (${timeZone})`;
		case 'weekly':
			return `Every ${DAYS[schedule.day]} at ${schedule.at} (${timeZone})`;
	}
}
