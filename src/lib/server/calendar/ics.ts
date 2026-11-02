import ICAL from 'ical.js';
import type {
	EventAttendee,
	EventInstance,
	EventStatus,
	EventWritePayload,
	RecurrenceRule,
	RRuleWeekday
} from '$lib/calendar/types';
import {
	normalizeTzid,
	parseWallClock,
	utcToWallClock,
	wallClockToIcs,
	wallClockToUtc,
	type WallClock
} from './tz';

/**
 * iCalendar parsing, recurrence expansion and generation.
 *
 * Strategy: VEVENTs are normalized into {@link VEventData} — wall-clock
 * start + IANA zone + duration — and all recurrence math happens in
 * wall-clock space (an ICAL.Recur iterator over zone-naive times). Each
 * occurrence is converted to a UTC instant via Intl at the end. This gives
 * Google/Apple-style DST behavior (a 9am weekly stays 9am local) for any
 * TZID the runtime knows, with or without VTIMEZONE blocks (RFC 7809).
 *
 * Edits regenerate the VCALENDAR from parsed data rather than patching the
 * original text; the representation round-trips every property the UI
 * exposes (plus SEQUENCE/CREATED/TRANSP/CLASS) so edits from other clients
 * keep their essentials.
 */

export interface VEventData {
	uid: string;
	/** Wall key (`YYYYMMDDTHHMMSS` / `YYYYMMDD`) when this VEVENT overrides one occurrence. */
	recurrenceId: string | null;
	/**
	 * Zone / date-ness the RECURRENCE-ID must be written in — the MASTER's,
	 * not the override's. An override edited from a browser in another zone
	 * legitimately changes its own DTSTART zone, but its RECURRENCE-ID must
	 * keep naming the original occurrence instant or the server and other
	 * clients can no longer match it to the series.
	 */
	ridTzid?: string;
	ridIsDate?: boolean;
	summary: string;
	description: string;
	location: string;
	allDay: boolean;
	/** IANA zone of startWall. 'UTC' covers Z-suffixed and floating times. */
	tzid: string;
	startWall: WallClock;
	/** Exact duration for timed events. */
	durationMs: number;
	/** Duration in days for all-day events (end exclusive). */
	durationDays: number;
	rrule: RecurrenceRule | null;
	/** Verbatim RRULE value — iteration source, survives parts the UI doesn't model. */
	rruleRaw: string | null;
	exdates: string[];
	rdates: string[];
	alarms: number[];
	status: EventStatus;
	transp: string | null;
	icalClass: string | null;
	attendees: EventAttendee[];
	organizer: { email: string; name: string | null } | null;
	sequence: number;
	created: string | null;
}

export interface ParsedObject {
	master: VEventData | null;
	overrides: VEventData[];
	/** iTIP METHOD of the enclosing VCALENDAR (REQUEST/REPLY/CANCEL/…), if any. */
	method: string | null;
}

const MAX_OCCURRENCES = 1000;
// Hard guard against pathological rules (e.g. BYDAY sets that never match):
// generous enough that a frequent series stays visible decades past DTSTART.
const MAX_ITERATIONS = 100_000;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function timeToWall(t: ICAL.Time): WallClock {
	return {
		year: t.year,
		month: t.month,
		day: t.day,
		hour: t.hour,
		minute: t.minute,
		second: t.second
	};
}

export function wallKey(wc: WallClock, allDay: boolean): string {
	const ics = wallClockToIcs(wc);
	return allDay ? ics.slice(0, 8) : ics;
}

/** Wall key → wall clock (midnight for a date key); null for a malformed key. */
export function keyToWall(key: string): WallClock | null {
	const iso = keyToIso(key);
	return parseWallClock(iso.length === 10 ? `${iso}T00:00` : iso);
}

/**
 * The zone a date-time value was written in: its TZID parameter (Windows
 * names mapped to IANA), 'UTC' for a Z suffix, null when it is floating or
 * the TZID is unknown — the wall text then stands as written.
 */
function valueZone(prop: ICAL.Property, time: ICAL.Time): string | null {
	const tzid = prop.getParameter('tzid');
	if (typeof tzid === 'string' && tzid) return normalizeTzid(tzid);
	return time.zone === ICAL.Timezone.utcTimezone ? 'UTC' : null;
}

function propZone(prop: ICAL.Property, time: ICAL.Time): string {
	// Unknown zones and floating times degrade to UTC rather than crashing the parse.
	return valueZone(prop, time) ?? 'UTC';
}

/**
 * Wall clock of a date-time value expressed in `tzid`. EXDATE, RDATE and
 * RECURRENCE-ID may be written in UTC or another zone (RFC 5545 §3.8.5.1),
 * while occurrences are keyed in the master's zone; without this conversion
 * such a value never matches the occurrence it names.
 */
function wallIn(prop: ICAL.Property, time: ICAL.Time, tzid: string): WallClock {
	const wc = timeToWall(time);
	const zone = valueZone(prop, time);
	if (time.isDate || !zone || zone === tzid) return wc;
	return utcToWallClock(wallClockToUtc(wc, zone), tzid);
}

function recurToRule(recur: ICAL.Recur, tzid: string): RecurrenceRule | null {
	const freq = recur.freq as RecurrenceRule['freq'];
	if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq)) return null;
	const rule: RecurrenceRule = { freq, interval: recur.interval || 1 };

	const parts = (recur as unknown as { parts?: Record<string, unknown[]> }).parts ?? {};
	const byDay = parts['BYDAY'] as string[] | undefined;
	if (byDay?.length) {
		if (freq === 'MONTHLY' && /^-?\d/.test(String(byDay[0]))) {
			rule.byDayOrdinal = String(byDay[0]);
		} else {
			rule.byDay = byDay.map((d) => String(d).replace(/^[+-]?\d+/, '')) as RRuleWeekday[];
		}
	}
	const byMonthDay = parts['BYMONTHDAY'] as number[] | undefined;
	if (byMonthDay?.length && freq === 'MONTHLY') rule.byMonthDay = Number(byMonthDay[0]);

	if (recur.count) rule.count = recur.count;
	if (recur.until) {
		const u = recur.until;
		let { year, month, day } = u;
		// A UTC UNTIL (Google's and our own form) names an instant; the model's
		// date is the local day that instant falls on in the series' zone.
		if (!u.isDate && u.zone === ICAL.Timezone.utcTimezone && tzid !== 'UTC') {
			({ year, month, day } = utcToWallClock(Date.UTC(u.year, u.month - 1, u.day, u.hour, u.minute, u.second), tzid));
		}
		rule.until = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
	}
	return rule;
}

function parseVEvent(vevent: ICAL.Component): VEventData | null {
	try {
		return parseVEventUnsafe(vevent);
	} catch (err) {
		// ical.js parses dates/durations/recurrences lazily, so a single
		// malformed property (a bad EXDATE, DURATION, TRIGGER, …) throws here
		// rather than at ICAL.parse. Swallow it so ONE quirky event can never
		// blank the whole calendar — the granular guards below keep most such
		// events visible; this is the last-resort backstop.
		console.warn('[calendar] skipped an unparseable VEVENT', err);
		return null;
	}
}

function parseVEventUnsafe(vevent: ICAL.Component): VEventData | null {
	const dtstartProp = vevent.getFirstProperty('dtstart');
	if (!dtstartProp) return null;
	const start = dtstartProp.getFirstValue() as ICAL.Time;
	if (!start || typeof start !== 'object' || !('year' in start)) return null;

	const allDay = !!start.isDate;
	const tzid = allDay ? 'UTC' : propZone(dtstartProp, start);
	const startWall = timeToWall(start);

	// Duration: explicit DURATION, else DTEND, else RFC 5545 defaults. Each
	// lazy value read is isolated — a bad DURATION/DTEND degrades to the
	// default length instead of dropping the event.
	let durationMs = 0;
	let durationDays = 1;
	let durationVal: ICAL.Duration | null = null;
	try {
		durationVal = vevent.getFirstPropertyValue('duration') as ICAL.Duration | null;
	} catch {
		durationVal = null;
	}
	const dtendProp = vevent.getFirstProperty('dtend');
	if (durationVal && typeof durationVal.toSeconds === 'function') {
		const secs = durationVal.toSeconds();
		durationMs = secs * 1000;
		durationDays = Math.max(1, Math.round(secs / 86400));
	} else if (dtendProp) {
		try {
			const end = dtendProp.getFirstValue() as ICAL.Time;
			if (allDay) {
				const a = Date.UTC(start.year, start.month - 1, start.day);
				const b = Date.UTC(end.year, end.month - 1, end.day);
				durationDays = Math.max(1, Math.round((b - a) / 86400000));
			} else {
				const endTz = propZone(dtendProp, end);
				durationMs = Math.max(
					0,
					wallClockToUtc(timeToWall(end), endTz) - wallClockToUtc(startWall, tzid)
				);
			}
		} catch {
			// Malformed DTEND — keep the event at its default length.
		}
	}

	// Recurrence. A malformed RRULE drops recurrence but keeps the base
	// occurrence visible, rather than losing the event.
	let rruleRaw: string | null = null;
	let rrule: RecurrenceRule | null = null;
	try {
		const rruleVal = vevent.getFirstPropertyValue('rrule') as ICAL.Recur | null;
		if (rruleVal && typeof rruleVal.toString === 'function') {
			rruleRaw = rruleVal.toString();
			rrule = recurToRule(rruleVal, tzid);
		}
	} catch {
		rruleRaw = null;
		rrule = null;
	}

	const collectDates = (name: string): string[] => {
		const keys: string[] = [];
		for (const prop of vevent.getAllProperties(name)) {
			try {
				for (const v of prop.getValues() as ICAL.Time[]) {
					if (v && typeof v === 'object' && 'year' in v) {
						keys.push(wallKey(allDay ? timeToWall(v) : wallIn(prop, v, tzid), allDay));
					}
				}
			} catch {
				// Malformed EXDATE/RDATE value — skip just this property.
			}
		}
		return keys;
	};

	// Alarms — only relative (duration) DISPLAY-style triggers before start.
	const alarms: number[] = [];
	for (const alarm of vevent.getAllSubcomponents('valarm')) {
		let trigger: ICAL.Duration | null = null;
		try {
			trigger = alarm.getFirstPropertyValue('trigger') as ICAL.Duration | null;
		} catch {
			continue; // bad TRIGGER — ignore this alarm
		}
		if (trigger && typeof trigger.toSeconds === 'function') {
			const secs = trigger.toSeconds();
			if (secs <= 0) alarms.push(Math.round(-secs / 60));
		}
	}

	const attendees: EventAttendee[] = [];
	for (const prop of vevent.getAllProperties('attendee')) {
		const raw = String(prop.getFirstValue() ?? '');
		const email = raw.replace(/^mailto:/i, '');
		if (!email) continue;
		const cn = prop.getParameter('cn');
		const partStat = prop.getParameter('partstat');
		const role = prop.getParameter('role');
		attendees.push({
			email,
			name: typeof cn === 'string' ? cn : undefined,
			partStat: typeof partStat === 'string' ? partStat : undefined,
			role: typeof role === 'string' ? role : undefined
		});
	}

	let organizer: VEventData['organizer'] = null;
	const orgProp = vevent.getFirstProperty('organizer');
	if (orgProp) {
		const email = String(orgProp.getFirstValue() ?? '').replace(/^mailto:/i, '');
		const cn = orgProp.getParameter('cn');
		if (email) organizer = { email, name: typeof cn === 'string' ? cn : null };
	}

	const statusRaw = String(vevent.getFirstPropertyValue('status') ?? '').toUpperCase();
	const status: EventStatus =
		statusRaw === 'TENTATIVE' ? 'tentative' : statusRaw === 'CANCELLED' ? 'cancelled' : 'confirmed';

	let recurrenceId: string | null = null;
	let ridTzid: string | undefined;
	let ridIsDate: boolean | undefined;
	const ridProp = vevent.getFirstProperty('recurrence-id');
	if (ridProp) {
		const rid = ridProp.getFirstValue() as ICAL.Time;
		if (rid && typeof rid === 'object' && 'year' in rid) {
			ridIsDate = !!rid.isDate;
			recurrenceId = wallKey(timeToWall(rid), ridIsDate);
			// Kept as written here; parseIcs re-keys it in the master's zone.
			ridTzid = ridIsDate ? 'UTC' : (valueZone(ridProp, rid) ?? undefined);
		}
	}

	const createdVal = vevent.getFirstPropertyValue('created') as ICAL.Time | null;
	return {
		uid: String(vevent.getFirstPropertyValue('uid') ?? ''),
		recurrenceId,
		ridTzid,
		ridIsDate,
		summary: String(vevent.getFirstPropertyValue('summary') ?? ''),
		description: String(vevent.getFirstPropertyValue('description') ?? ''),
		location: String(vevent.getFirstPropertyValue('location') ?? ''),
		allDay,
		tzid,
		startWall,
		durationMs,
		durationDays,
		rrule,
		rruleRaw,
		exdates: collectDates('exdate'),
		rdates: collectDates('rdate'),
		alarms,
		status,
		transp: (vevent.getFirstPropertyValue('transp') as string | null) ?? null,
		icalClass: (vevent.getFirstPropertyValue('class') as string | null) ?? null,
		attendees,
		organizer,
		sequence: Number(vevent.getFirstPropertyValue('sequence') ?? 0) || 0,
		// toICALString() gives the wire form (20250101T120000Z) — toString()
		// gives ISO with dashes/colons, which is NOT a valid ICS DATE-TIME
		// and can make strict servers reject the whole object on rewrite.
		created:
			createdVal && typeof createdVal.toICALString === 'function'
				? createdVal.toICALString()
				: null
	};
}

/**
 * Retry parse after stripping the recurrence properties ical.js parses
 * eagerly (and throws on when malformed, e.g. RRULE:...;COUNT=). Recovers the
 * event's base occurrence instead of losing it wholesale. Unfolds first so a
 * folded continuation line never gets orphaned.
 */
function salvageParse(ics: string): ICAL.Component | null {
	const unfolded = ics.replace(/\r?\n[ \t]/g, '');
	const cleaned = unfolded
		.split(/\r?\n/)
		.filter((line) => !/^(RRULE|EXDATE|RDATE)[:;]/i.test(line))
		.join('\r\n');
	try {
		return new ICAL.Component(ICAL.parse(cleaned));
	} catch {
		return null;
	}
}

export function parseIcs(ics: string): ParsedObject {
	let comp: ICAL.Component;
	try {
		comp = new ICAL.Component(ICAL.parse(ics));
	} catch {
		const salvaged = salvageParse(ics);
		if (!salvaged) return { master: null, overrides: [], method: null };
		comp = salvaged;
	}
	let master: VEventData | null = null;
	const overrides: VEventData[] = [];
	for (const vevent of comp.getAllSubcomponents('vevent')) {
		const data = parseVEvent(vevent);
		if (!data) continue;
		if (data.recurrenceId) overrides.push(data);
		else if (!master) master = data;
	}
	if (master) for (const o of overrides) alignOverrideKey(o, master);
	const methodRaw = comp.getFirstPropertyValue('method');
	const method = typeof methodRaw === 'string' && methodRaw ? methodRaw.toUpperCase() : null;
	return { master, overrides, method };
}

/**
 * Re-key an override in the master's terms. A RECURRENCE-ID may be written
 * in another zone, or as a date-time on an all-day series (sloppy
 * producers); the master indexes its occurrences by its own zone and
 * date-ness, so the override is converted once here and every later
 * comparison — expansion, edits, deletes, iMIP merges — is exact.
 */
function alignOverrideKey(o: VEventData, master: Pick<VEventData, 'tzid' | 'allDay'>): void {
	if (!o.recurrenceId) return;
	if (master.allDay) {
		o.recurrenceId = o.recurrenceId.slice(0, 8);
		o.ridIsDate = true;
		o.ridTzid = 'UTC';
		return;
	}
	if (!o.ridIsDate && o.ridTzid && o.ridTzid !== master.tzid) {
		const wc = keyToWall(o.recurrenceId);
		if (wc) o.recurrenceId = wallKey(utcToWallClock(wallClockToUtc(wc, o.ridTzid), master.tzid), false);
	}
	o.ridTzid = master.tzid;
}

/**
 * One VEVENT component read as an override of `master` (keyed like the
 * master's occurrences), or null when it has no RECURRENCE-ID. For callers
 * that edit a stored object component by component (iMIP merges).
 */
export function parseOverride(vevent: ICAL.Component, master: Pick<VEventData, 'tzid' | 'allDay'>): VEventData | null {
	const data = parseVEvent(vevent);
	if (!data?.recurrenceId) return null;
	alignOverrideKey(data, master);
	return data;
}

// ---------------------------------------------------------------------------
// Expansion
// ---------------------------------------------------------------------------

function wallToStartIso(wc: WallClock, tzid: string, allDay: boolean): { iso: string; utcMs: number } {
	if (allDay) {
		const iso = `${String(wc.year).padStart(4, '0')}-${String(wc.month).padStart(2, '0')}-${String(wc.day).padStart(2, '0')}`;
		return { iso, utcMs: Date.UTC(wc.year, wc.month - 1, wc.day) };
	}
	const utcMs = wallClockToUtc(wc, tzid);
	return { iso: new Date(utcMs).toISOString(), utcMs };
}

function addDaysToWall(wc: WallClock, days: number): WallClock {
	const d = new Date(Date.UTC(wc.year, wc.month - 1, wc.day + days));
	return {
		year: d.getUTCFullYear(),
		month: d.getUTCMonth() + 1,
		day: d.getUTCDate(),
		hour: 0,
		minute: 0,
		second: 0
	};
}

/** Wall key → `YYYY-MM-DD[THH:mm:ss]` (the client-facing recurrenceId form). */
export function keyToIso(key: string): string {
	const d = `${key.slice(0, 4)}-${key.slice(4, 6)}-${key.slice(6, 8)}`;
	if (key.length === 8) return d;
	return `${d}T${key.slice(9, 11)}:${key.slice(11, 13)}:${key.slice(13, 15)}`;
}

/** Client recurrenceId → wall key. */
export function isoToKey(iso: string): string {
	return iso.replace(/[-:]/g, '');
}

function instanceFromData(
	data: VEventData,
	id: string,
	calendarId: string,
	startOverride: WallClock | null,
	recurrenceKey: string | null,
	masterRRule: RecurrenceRule | null
): EventInstance {
	const startWall = startOverride ?? data.startWall;
	const { iso: startIso, utcMs: startMs } = wallToStartIso(startWall, data.tzid, data.allDay);
	let endIso: string;
	if (data.allDay) {
		const endWall = addDaysToWall(startWall, data.durationDays);
		endIso = wallToStartIso(endWall, data.tzid, true).iso;
	} else {
		endIso = new Date(startMs + data.durationMs).toISOString();
	}
	return {
		id,
		calendarId,
		uid: data.uid,
		title: data.summary,
		description: data.description,
		location: data.location,
		start: startIso,
		end: endIso,
		allDay: data.allDay,
		recurring: recurrenceKey !== null,
		recurrenceId: recurrenceKey ? keyToIso(recurrenceKey) : null,
		rrule: masterRRule,
		alarms: data.alarms,
		status: data.status,
		attendees: data.attendees,
		organizer: data.organizer?.email ?? null,
		timeZone: data.allDay ? null : data.tzid
	};
}

function dataEndMs(data: VEventData, startWall: WallClock): number {
	if (data.allDay) {
		const end = addDaysToWall(startWall, data.durationDays);
		return Date.UTC(end.year, end.month - 1, end.day);
	}
	return wallClockToUtc(startWall, data.tzid) + data.durationMs;
}

function dataStartMs(data: VEventData, startWall: WallClock): number {
	if (data.allDay) return Date.UTC(startWall.year, startWall.month - 1, startWall.day);
	return wallClockToUtc(startWall, data.tzid);
}

/**
 * Expand one parsed object into renderable instances overlapping
 * [rangeStartMs, rangeEndMs).
 */
export function expandToInstances(
	parsed: ParsedObject,
	id: string,
	calendarId: string,
	rangeStartMs: number,
	rangeEndMs: number
): EventInstance[] {
	const { master, overrides } = parsed;
	const out: EventInstance[] = [];
	const emittedOverrideKeys = new Set<string>();

	if (master) {
		if (!master.rruleRaw && master.rdates.length === 0) {
			// Plain single event.
			const startMs = dataStartMs(master, master.startWall);
			const endMs = dataEndMs(master, master.startWall);
			if (endMs > rangeStartMs && startMs < rangeEndMs) {
				out.push(instanceFromData(master, id, calendarId, null, null, null));
			}
		} else {
			const exdates = new Set(master.exdates);
			// Overrides are matched at the master's key granularity: an all-day
			// master indexes occurrences by date, so a date-time RECURRENCE-ID
			// (sloppy producers) must still find its slot.
			const normKey = (k: string) => (master.allDay ? k.slice(0, 8) : k);
			const overrideByKey = new Map(overrides.map((o) => [normKey(o.recurrenceId as string), o]));

			// Collect occurrence wall clocks: RRULE iterator (UNTIL stripped —
			// enforced below against true UTC instants) plus RDATEs.
			const occurrences = new Map<string, WallClock>();
			const masterKey = wallKey(master.startWall, master.allDay);

			// UNTIL with full precision from the raw rule (the UI model only
			// keeps the date part); per RFC 5545 an occurrence starting exactly
			// AT the UNTIL instant is still included.
			let untilMs = Infinity;
			const rawUntil = master.rruleRaw?.match(/UNTIL=(\d{8}(?:T\d{6}Z?)?)/i)?.[1];
			if (rawUntil) {
				const y = +rawUntil.slice(0, 4);
				const m = +rawUntil.slice(4, 6);
				const d = +rawUntil.slice(6, 8);
				if (rawUntil.length === 8) {
					// DATE form: covers occurrences through the end of that day.
					untilMs = master.allDay
						? Date.UTC(y, m - 1, d)
						: wallClockToUtc({ year: y, month: m, day: d, hour: 23, minute: 59, second: 59 }, master.tzid);
				} else {
					const wc: WallClock = {
						year: y, month: m, day: d,
						hour: +rawUntil.slice(9, 11),
						minute: +rawUntil.slice(11, 13),
						second: +rawUntil.slice(13, 15)
					};
					untilMs = rawUntil.endsWith('Z')
						? Date.UTC(wc.year, wc.month - 1, wc.day, wc.hour, wc.minute, wc.second)
						: wallClockToUtc(wc, master.tzid);
				}
			} else if (master.rrule?.until) {
				const [y, m, d] = master.rrule.until.split('-').map(Number);
				untilMs = master.allDay
					? Date.UTC(y, m - 1, d)
					: wallClockToUtc({ year: y, month: m, day: d, hour: 23, minute: 59, second: 59 }, master.tzid);
			}

			if (master.rruleRaw) {
				try {
					const recur = ICAL.Recur.fromString(master.rruleRaw.replace(/;?UNTIL=[^;]+/i, ''));
					// Re-apply COUNT semantics from the raw rule (kept by fromString).
					// Zone-naive iteration: UTC stands in for "floating" so all
					// comparisons stay in wall-clock space.
					const dtstart = new ICAL.Time(
						{
							year: master.startWall.year,
							month: master.startWall.month,
							day: master.startWall.day,
							hour: master.startWall.hour,
							minute: master.startWall.minute,
							second: master.startWall.second,
							isDate: master.allDay
						},
						ICAL.Timezone.utcTimezone
					);
					const iter = recur.iterator(dtstart);
					let next: ICAL.Time | null;
					// Two separate bounds: `emitted` caps what one range can
					// render; `steps` is a loop guard for pathological rules.
					// Capping raw iterations at the render limit silently
					// blanked any frequent series once the viewed range was
					// more than MAX_OCCURRENCES steps past DTSTART (a daily
					// event vanished ~2.7 years in).
					let emitted = 0;
					let steps = 0;
					while ((next = iter.next()) && emitted < MAX_OCCURRENCES && steps < MAX_ITERATIONS) {
						steps++;
						const wc = timeToWall(next);
						const startMs = dataStartMs(master, wc);
						if (startMs > untilMs) break;
						if (startMs >= rangeEndMs) break;
						// Skip pre-range occurrences cheaply; overrides that moved
						// into the range are handled separately below.
						if (dataEndMs(master, wc) <= rangeStartMs && !overrideByKey.has(wallKey(wc, master.allDay))) {
							continue;
						}
						emitted++;
						occurrences.set(wallKey(wc, master.allDay), wc);
					}
				} catch {
					// Unparseable RRULE — fall back to the base occurrence.
					occurrences.set(masterKey, master.startWall);
				}
			} else {
				occurrences.set(masterKey, master.startWall);
			}
			for (const rk of master.rdates) {
				const iso = keyToIso(rk);
				const wc = parseWallClock(iso.length === 10 ? `${iso}T00:00` : iso);
				if (wc) occurrences.set(rk, wc);
			}

			for (const [key, wc] of occurrences) {
				if (exdates.has(key)) continue;
				const override = overrideByKey.get(key);
				const data = override ?? master;
				const startWall = override ? override.startWall : wc;
				const startMs = dataStartMs(data, startWall);
				const endMs = dataEndMs(data, startWall);
				if (endMs <= rangeStartMs || startMs >= rangeEndMs) continue;
				out.push(instanceFromData(data, id, calendarId, startWall, key, master.rrule));
				if (override) emittedOverrideKeys.add(key);
			}

			// Overrides moved into the range from an occurrence outside it.
			for (const o of overrides) {
				const key = normKey(o.recurrenceId as string);
				if (emittedOverrideKeys.has(key)) continue;
				const startMs = dataStartMs(o, o.startWall);
				const endMs = dataEndMs(o, o.startWall);
				if (endMs <= rangeStartMs || startMs >= rangeEndMs) continue;
				if (exdates.has(key)) continue;
				out.push(instanceFromData(o, id, calendarId, o.startWall, key, master.rrule));
			}
		}
	} else {
		// Orphan overrides (no master in this object).
		for (const o of overrides) {
			const startMs = dataStartMs(o, o.startWall);
			const endMs = dataEndMs(o, o.startWall);
			if (endMs <= rangeStartMs || startMs >= rangeEndMs) continue;
			out.push(instanceFromData(o, id, calendarId, o.startWall, o.recurrenceId, null));
		}
	}

	return out;
}

/**
 * True when `key` names an occurrence the series actually generates (RRULE
 * or RDATE; EXDATEs are ignored). Overrides are kept only while this holds —
 * one pointing at no occurrence would render as a stray extra event.
 */
export function occurrenceExists(master: VEventData, key: string): boolean {
	const wc = keyToWall(key);
	if (!wc) return false;
	const at = master.allDay ? Date.UTC(wc.year, wc.month - 1, wc.day) : wallClockToUtc(wc, master.tzid);
	const want = keyToIso(master.allDay ? key.slice(0, 8) : key);
	const probe: ParsedObject = { master: { ...master, exdates: [] }, overrides: [], method: null };
	return expandToInstances(probe, '', '', at - 86400000, at + 86400000).some((i) => i.recurrenceId === want);
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

function escapeText(s: string): string {
	return s
		.replace(/\\/g, '\\\\')
		.replace(/;/g, '\\;')
		.replace(/,/g, '\\,')
		.replace(/\r?\n/g, '\\n');
}

/** RFC 5545 §3.1 line folding at 74 octets (UTF-8 safe split point). */
function foldLine(line: string): string {
	if (line.length <= 74) return line;
	const parts: string[] = [];
	let rest = line;
	let first = true;
	while (rest.length > (first ? 74 : 73)) {
		const limit = first ? 74 : 73;
		// Avoid splitting a surrogate pair.
		let cut = limit;
		if (/[\uD800-\uDBFF]/.test(rest[cut - 1])) cut -= 1;
		parts.push((first ? '' : ' ') + rest.slice(0, cut));
		rest = rest.slice(cut);
		first = false;
	}
	parts.push((first ? '' : ' ') + rest);
	return parts.join('\r\n');
}

function dtLine(name: string, data: VEventData, wc: WallClock): string {
	if (data.allDay) return `${name};VALUE=DATE:${wallClockToIcs(wc).slice(0, 8)}`;
	if (data.tzid === 'UTC') return `${name}:${wallClockToIcs(wc)}Z`;
	return `${name};TZID=${data.tzid}:${wallClockToIcs(wc)}`;
}

/** `YYYYMMDDTHHMMSSZ` for a UTC instant. */
function icsUtc(ms: number): string {
	return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/**
 * RRULE UNTIL for a series that ends on `untilIso` (YYYY-MM-DD, inclusive).
 * RFC 5545: a DATE when DTSTART is a DATE — a DATE-TIME there makes the whole
 * series invalid for strict consumers. Otherwise a UTC instant: the last
 * second of that day *in the series' own zone*. A bare `T235959Z` ends the
 * day hours early east of UTC and hours late west of it, which drops or
 * keeps a whole occurrence at the boundary.
 */
export function untilValue(untilIso: string, allDay: boolean, tzid: string): string {
	if (allDay) return untilIso.replace(/-/g, '');
	const [year, month, day] = untilIso.split('-').map(Number);
	return icsUtc(wallClockToUtc({ year, month, day, hour: 23, minute: 59, second: 59 }, tzid));
}

export function buildRRuleString(rule: RecurrenceRule, allDay = false, tzid = 'UTC'): string {
	const parts = [`FREQ=${rule.freq}`];
	if (rule.interval > 1) parts.push(`INTERVAL=${rule.interval}`);
	if (rule.byDay?.length) parts.push(`BYDAY=${rule.byDay.join(',')}`);
	if (rule.byDayOrdinal) parts.push(`BYDAY=${rule.byDayOrdinal}`);
	if (rule.byMonthDay) parts.push(`BYMONTHDAY=${rule.byMonthDay}`);
	if (rule.count) parts.push(`COUNT=${rule.count}`);
	else if (rule.until) parts.push(`UNTIL=${untilValue(rule.until, allDay, tzid)}`);
	return parts.join(';');
}

function buildVEvent(data: VEventData, dtstamp: string): string[] {
	const lines: string[] = ['BEGIN:VEVENT'];
	lines.push(`UID:${escapeText(data.uid)}`);
	lines.push(`DTSTAMP:${dtstamp}`);
	if (data.recurrenceId) {
		const iso = keyToIso(data.recurrenceId);
		const wc = parseWallClock(iso.length === 10 ? `${iso}T00:00` : iso);
		// RECURRENCE-ID names the ORIGINAL occurrence: written in the
		// master's zone / date-ness, not the (possibly rescheduled,
		// possibly different-zone) override's.
		const ridCtx = {
			...data,
			allDay: data.ridIsDate ?? data.allDay,
			tzid: data.ridTzid ?? data.tzid
		};
		if (wc) lines.push(dtLine('RECURRENCE-ID', ridCtx, wc));
	}
	lines.push(dtLine('DTSTART', data, data.startWall));
	if (data.allDay) {
		lines.push(dtLine('DTEND', data, addDaysToWall(data.startWall, data.durationDays)));
	} else {
		const endUtc = wallClockToUtc(data.startWall, data.tzid) + data.durationMs;
		const endWall = data.tzid === 'UTC' ? utcToWallClock(endUtc, 'UTC') : utcToWallClock(endUtc, data.tzid);
		lines.push(dtLine('DTEND', data, endWall));
	}
	if (data.summary) lines.push(`SUMMARY:${escapeText(data.summary)}`);
	if (data.description) lines.push(`DESCRIPTION:${escapeText(data.description)}`);
	if (data.location) lines.push(`LOCATION:${escapeText(data.location)}`);
	if (data.rruleRaw && !data.recurrenceId) lines.push(`RRULE:${data.rruleRaw}`);
	for (const ex of data.exdates) {
		const iso = keyToIso(ex);
		const wc = parseWallClock(iso.length === 10 ? `${iso}T00:00` : iso);
		if (wc) lines.push(dtLine('EXDATE', data, wc));
	}
	for (const rd of data.rdates) {
		const iso = keyToIso(rd);
		const wc = parseWallClock(iso.length === 10 ? `${iso}T00:00` : iso);
		if (wc) lines.push(dtLine('RDATE', data, wc));
	}
	lines.push(`STATUS:${data.status.toUpperCase()}`);
	if (data.transp) lines.push(`TRANSP:${data.transp}`);
	if (data.icalClass) lines.push(`CLASS:${data.icalClass}`);
	if (data.created) lines.push(`CREATED:${data.created}`);
	lines.push(`SEQUENCE:${data.sequence}`);
	if (data.organizer) {
		const cn = data.organizer.name ? `;CN=${quoteParam(data.organizer.name)}` : '';
		lines.push(`ORGANIZER${cn}:mailto:${data.organizer.email}`);
	}
	for (const a of data.attendees) {
		const params: string[] = [];
		if (a.name) params.push(`CN=${quoteParam(a.name)}`);
		params.push(`ROLE=${a.role ?? 'REQ-PARTICIPANT'}`);
		params.push(`PARTSTAT=${a.partStat ?? 'NEEDS-ACTION'}`);
		params.push('RSVP=TRUE');
		lines.push(`ATTENDEE;${params.join(';')}:mailto:${a.email}`);
	}
	for (const minutes of data.alarms) {
		lines.push('BEGIN:VALARM');
		lines.push('ACTION:DISPLAY');
		lines.push(`DESCRIPTION:${escapeText(data.summary || 'Reminder')}`);
		lines.push(minutes === 0 ? 'TRIGGER:PT0S' : `TRIGGER:-PT${minutes}M`);
		lines.push('END:VALARM');
	}
	lines.push('END:VEVENT');
	return lines;
}

function quoteParam(v: string): string {
	const clean = v.replace(/[\r\n"]/g, '');
	return /[;:,]/.test(clean) ? `"${clean}"` : clean;
}

export function buildIcs(master: VEventData, overrides: VEventData[] = []): string {
	const dtstamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
	const lines: string[] = [
		'BEGIN:VCALENDAR',
		'VERSION:2.0',
		'PRODID:-//Zajel Mail//webmail calendar//EN',
		'CALSCALE:GREGORIAN'
	];
	lines.push(...buildVEvent(master, dtstamp));
	for (const o of overrides) lines.push(...buildVEvent(o, dtstamp));
	lines.push('END:VCALENDAR');
	return lines.map(foldLine).join('\r\n') + '\r\n';
}

/** Map a client write payload onto VEventData. */
export function payloadToData(
	payload: EventWritePayload,
	uid: string,
	base?: Partial<
		Pick<
			VEventData,
			'sequence' | 'created' | 'recurrenceId' | 'ridTzid' | 'ridIsDate' | 'exdates' | 'organizer'
		>
	>
): VEventData | null {
	const allDay = payload.allDay;
	let startWall: WallClock | null;
	let durationMs = 0;
	let durationDays = 1;
	const tzid = allDay ? 'UTC' : payload.timeZone || 'UTC';

	if (allDay) {
		startWall = parseWallClock(`${payload.start}T00:00`);
		const endWall = parseWallClock(`${payload.end}T00:00`);
		if (!startWall || !endWall) return null;
		const a = Date.UTC(startWall.year, startWall.month - 1, startWall.day);
		const b = Date.UTC(endWall.year, endWall.month - 1, endWall.day);
		durationDays = Math.max(1, Math.round((b - a) / 86400000));
	} else {
		startWall = parseWallClock(payload.start);
		const endWall = parseWallClock(payload.end);
		if (!startWall || !endWall) return null;
		durationMs = Math.max(0, wallClockToUtc(endWall, tzid) - wallClockToUtc(startWall, tzid));
		if (durationMs === 0) durationMs = 30 * 60 * 1000;
	}

	const rrule = payload.rrule ?? null;
	return {
		uid,
		recurrenceId: base?.recurrenceId ?? null,
		ridTzid: base?.ridTzid,
		ridIsDate: base?.ridIsDate,
		summary: payload.title ?? '',
		description: payload.description ?? '',
		location: payload.location ?? '',
		allDay,
		tzid,
		startWall,
		durationMs,
		durationDays,
		rrule,
		rruleRaw: rrule ? buildRRuleString(rrule, allDay, tzid) : null,
		exdates: base?.exdates ?? [],
		rdates: [],
		alarms: payload.alarms ?? [],
		status: payload.status ?? 'confirmed',
		transp: null,
		icalClass: null,
		attendees: payload.attendees ?? [],
		organizer: base?.organizer ?? null,
		sequence: base?.sequence ?? 0,
		created: base?.created ?? null
	};
}
