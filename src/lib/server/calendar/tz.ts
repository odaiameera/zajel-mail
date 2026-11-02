import ICAL from 'ical.js';

/**
 * Wall-clock ⇄ UTC conversion backed by the Intl API, so any IANA timezone
 * the runtime knows works without shipping VTIMEZONE data. iCalendar stores
 * recurring events as wall-clock times plus a TZID (RFC 7809 allows the
 * TZID-by-reference form Stalwart emits), and recurrence math must happen in
 * wall-clock space for DST to behave like Google/Apple calendars — a 9am
 * weekly meeting stays 9am local across transitions.
 *
 * Zones Intl cannot name (Outlook's "Customized Time Zone", a vendor's own
 * id) are read from the VTIMEZONE the object carries, through ical.js.
 */

/** The zone of a time written with neither TZID nor Z: it reads as written wherever it is viewed. */
export const FLOATING = 'floating';

// Definitions registered from VTIMEZONE blocks, keyed by their TZID. One
// object is parsed and expanded (or rewritten) in one synchronous stretch,
// so the definition in force is the one that object came with; two senders
// using the same made-up name with different rules could only collide
// across requests, and the last parse wins.
const customZones = new Map<string, ICAL.Timezone>();

export interface WallClock {
	year: number;
	month: number; // 1-12
	day: number;
	hour: number;
	minute: number;
	second: number;
}

const dtfCache = new Map<string, Intl.DateTimeFormat>();
// Offset lookups repeat heavily during recurrence expansion (same zone,
// nearby instants). Cache per zone+hour-bucket — offsets never change
// mid-hour in the IANA database.
const offsetCache = new Map<string, number>();

function getDtf(timeZone: string): Intl.DateTimeFormat {
	let dtf = dtfCache.get(timeZone);
	if (!dtf) {
		dtf = new Intl.DateTimeFormat('en-US', {
			timeZone,
			hour12: false,
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit'
		});
		dtfCache.set(timeZone, dtf);
	}
	return dtf;
}

export function isValidTimeZone(timeZone: string): boolean {
	try {
		getDtf(timeZone);
		return true;
	} catch {
		return false;
	}
}

/**
 * Windows timezone names → IANA, for invitations produced by Outlook /
 * Exchange (their VTIMEZONE TZIDs are CLDR "windowsZones" ids, not IANA).
 * Subset covering the common cases; unknown ids fall back to UTC upstream.
 */
const WINDOWS_TZ: Record<string, string> = {
	'Dateline Standard Time': 'Etc/GMT+12',
	'Hawaiian Standard Time': 'Pacific/Honolulu',
	'Alaskan Standard Time': 'America/Anchorage',
	'Pacific Standard Time': 'America/Los_Angeles',
	'Pacific Standard Time (Mexico)': 'America/Tijuana',
	'Mountain Standard Time': 'America/Denver',
	'US Mountain Standard Time': 'America/Phoenix',
	'Central Standard Time': 'America/Chicago',
	'Central America Standard Time': 'America/Guatemala',
	'Eastern Standard Time': 'America/New_York',
	'US Eastern Standard Time': 'America/Indiana/Indianapolis',
	'Atlantic Standard Time': 'America/Halifax',
	'SA Pacific Standard Time': 'America/Bogota',
	'SA Western Standard Time': 'America/La_Paz',
	'Venezuela Standard Time': 'America/Caracas',
	'E. South America Standard Time': 'America/Sao_Paulo',
	'Argentina Standard Time': 'America/Argentina/Buenos_Aires',
	'Greenland Standard Time': 'America/Godthab',
	UTC: 'UTC',
	'GMT Standard Time': 'Europe/London',
	'Greenwich Standard Time': 'Atlantic/Reykjavik',
	'Morocco Standard Time': 'Africa/Casablanca',
	'W. Europe Standard Time': 'Europe/Berlin',
	'Central Europe Standard Time': 'Europe/Budapest',
	'Central European Standard Time': 'Europe/Warsaw',
	'Romance Standard Time': 'Europe/Paris',
	'W. Central Africa Standard Time': 'Africa/Lagos',
	'GTB Standard Time': 'Europe/Bucharest',
	'FLE Standard Time': 'Europe/Kiev',
	'E. Europe Standard Time': 'Europe/Chisinau',
	'Egypt Standard Time': 'Africa/Cairo',
	'South Africa Standard Time': 'Africa/Johannesburg',
	'Jordan Standard Time': 'Asia/Amman',
	'Middle East Standard Time': 'Asia/Beirut',
	'Israel Standard Time': 'Asia/Jerusalem',
	'Turkey Standard Time': 'Europe/Istanbul',
	'Arabic Standard Time': 'Asia/Baghdad',
	'Arab Standard Time': 'Asia/Riyadh',
	'Arabian Standard Time': 'Asia/Dubai',
	'Russian Standard Time': 'Europe/Moscow',
	'Iran Standard Time': 'Asia/Tehran',
	'Afghanistan Standard Time': 'Asia/Kabul',
	'West Asia Standard Time': 'Asia/Tashkent',
	'Pakistan Standard Time': 'Asia/Karachi',
	'India Standard Time': 'Asia/Kolkata',
	'Sri Lanka Standard Time': 'Asia/Colombo',
	'Nepal Standard Time': 'Asia/Kathmandu',
	'Bangladesh Standard Time': 'Asia/Dhaka',
	'Myanmar Standard Time': 'Asia/Yangon',
	'SE Asia Standard Time': 'Asia/Bangkok',
	'China Standard Time': 'Asia/Shanghai',
	'Singapore Standard Time': 'Asia/Singapore',
	'Taipei Standard Time': 'Asia/Taipei',
	'Tokyo Standard Time': 'Asia/Tokyo',
	'Korea Standard Time': 'Asia/Seoul',
	'W. Australia Standard Time': 'Australia/Perth',
	'Cen. Australia Standard Time': 'Australia/Adelaide',
	'AUS Eastern Standard Time': 'Australia/Sydney',
	'E. Australia Standard Time': 'Australia/Brisbane',
	'New Zealand Standard Time': 'Pacific/Auckland'
};

/**
 * Resolve a TZID from the wire to something Intl understands: IANA names
 * pass through, Windows names map via {@link WINDOWS_TZ}, anything else
 * returns null (callers fall back to UTC rather than crash).
 */
export function normalizeTzid(tzid: string): string | null {
	const clean = tzid.replace(/^\//, '').trim();
	if (!clean) return null;
	if (isValidTimeZone(clean)) return clean;
	const mapped = WINDOWS_TZ[clean];
	if (mapped && isValidTimeZone(mapped)) return mapped;
	if (customZones.has(clean)) return clean;
	return null;
}

/**
 * Make a VTIMEZONE's rules available under its TZID when nothing else can
 * resolve it. Zones Intl knows are left to Intl: current rules rather than
 * the snapshot a sender shipped. Returns the id registered, or null.
 */
export function registerVTimezone(component: ICAL.Component): string | null {
	const tzid = component.getFirstPropertyValue('tzid');
	if (typeof tzid !== 'string' || !tzid.trim()) return null;
	const clean = tzid.replace(/^\//, '').trim();
	if (isValidTimeZone(clean) || (WINDOWS_TZ[clean] && isValidTimeZone(WINDOWS_TZ[clean]))) return null;
	try {
		customZones.set(clean, new ICAL.Timezone({ component, tzid: clean }));
	} catch {
		return null;
	}
	return clean;
}

/** Milliseconds east of UTC for `timeZone` at the given UTC instant. */
function tzOffsetMs(timeZone: string, utcMs: number): number {
	const bucket = `${timeZone}:${Math.floor(utcMs / 3_600_000)}`;
	const cached = offsetCache.get(bucket);
	if (cached !== undefined) return cached;

	const parts = getDtf(timeZone).formatToParts(new Date(utcMs));
	const v: Record<string, number> = {};
	for (const p of parts) {
		if (p.type !== 'literal') v[p.type] = Number(p.value);
	}
	// Intl can emit hour "24" for midnight.
	const hour = v.hour === 24 ? 0 : v.hour;
	const asUtc = Date.UTC(v.year, v.month - 1, v.day, hour, v.minute, v.second);
	// Compare against the instant truncated to whole seconds — formatToParts
	// has second precision and sub-second drift would corrupt the offset.
	const offset = asUtc - Math.floor(utcMs / 1000) * 1000;
	offsetCache.set(bucket, offset);
	return offset;
}

/**
 * Interpret a wall-clock time in `timeZone` and return the UTC epoch (ms).
 * Two-pass fixed-point handles DST: for skipped local times (spring
 * forward) this lands on the post-transition instant, matching the
 * behavior of major calendar clients.
 */
export function wallClockToUtc(wc: WallClock, timeZone: string): number {
	const naive = Date.UTC(wc.year, wc.month - 1, wc.day, wc.hour, wc.minute, wc.second);
	if (timeZone === 'UTC' || timeZone === 'Etc/UTC' || timeZone === 'Z' || timeZone === FLOATING) return naive;
	const custom = customZones.get(timeZone);
	if (custom) {
		const t = ICAL.Time.fromData(
			{ year: wc.year, month: wc.month, day: wc.day, hour: wc.hour, minute: wc.minute, second: wc.second, isDate: false },
			custom
		);
		return t.toUnixTime() * 1000;
	}
	try {
		let offset = tzOffsetMs(timeZone, naive);
		offset = tzOffsetMs(timeZone, naive - offset);
		return naive - offset;
	} catch {
		// Unknown zone slipped through normalization — degrade to UTC.
		return naive;
	}
}

/** Wall-clock fields of a UTC instant as seen in `timeZone`. */
export function utcToWallClock(utcMs: number, timeZone: string): WallClock {
	const custom = customZones.get(timeZone);
	if (custom) {
		const t = ICAL.Time.fromJSDate(new Date(Math.floor(utcMs / 1000) * 1000), true).convertToZone(custom);
		return { year: t.year, month: t.month, day: t.day, hour: t.hour, minute: t.minute, second: t.second };
	}
	let parts: Intl.DateTimeFormatPart[];
	try {
		parts = getDtf(timeZone === FLOATING ? 'UTC' : timeZone).formatToParts(new Date(utcMs));
	} catch {
		parts = getDtf('UTC').formatToParts(new Date(utcMs));
	}
	const v: Record<string, number> = {};
	for (const p of parts) {
		if (p.type !== 'literal') v[p.type] = Number(p.value);
	}
	return {
		year: v.year,
		month: v.month,
		day: v.day,
		hour: v.hour === 24 ? 0 : v.hour,
		minute: v.minute,
		second: v.second
	};
}

/** `YYYYMMDDTHHMMSS` (iCalendar local form) for a wall clock. */
export function wallClockToIcs(wc: WallClock): string {
	const p = (n: number, w = 2) => String(n).padStart(w, '0');
	return `${p(wc.year, 4)}${p(wc.month)}${p(wc.day)}T${p(wc.hour)}${p(wc.minute)}${p(wc.second)}`;
}

/** Parse `YYYY-MM-DDTHH:mm[:ss]` (payload wall-clock form). */
export function parseWallClock(value: string): WallClock | null {
	const m = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
	if (!m) return null;
	return {
		year: +m[1],
		month: +m[2],
		day: +m[3],
		hour: +m[4],
		minute: +m[5],
		second: m[6] ? +m[6] : 0
	};
}
