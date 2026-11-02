import { parseWallClock, type WallClock } from '$lib/server/calendar/tz';

/**
 * Local dates and times as the model writes them: "YYYY-MM-DDTHH:mm", or
 * "YYYY-MM-DD" for a whole day. parseWallClock checks the shape only, and
 * the zone maths then rolls an impossible value over (31 November becomes
 * 1 December, 24:00 the next morning), so every field is checked against a
 * real calendar here first. Null when the value isn't a moment that exists,
 * so the tool can tell the model instead of acting on the wrong day.
 */

const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;

function exists(w: WallClock): boolean {
	const d = new Date(Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second));
	return (
		d.getUTCFullYear() === w.year &&
		d.getUTCMonth() === w.month - 1 &&
		d.getUTCDate() === w.day &&
		d.getUTCHours() === w.hour &&
		d.getUTCMinutes() === w.minute &&
		d.getUTCSeconds() === w.second
	);
}

/** A real local time, "YYYY-MM-DDTHH:mm" (seconds allowed), or null. */
export function parseLocalTime(value: unknown): WallClock | null {
	if (typeof value !== 'string') return null;
	const wall = parseWallClock(value.trim().slice(0, 20));
	return wall && exists(wall) ? wall : null;
}

/** A real date, "YYYY-MM-DD", as the wall clock of its midnight, or null. */
export function parseLocalDate(value: unknown): WallClock | null {
	if (typeof value !== 'string' || !LOCAL_DATE.test(value.trim())) return null;
	return parseLocalTime(`${value.trim()}T00:00`);
}
