import type { EventAttendee, EventWritePayload } from '$lib/calendar/types';
import { utcToWallClock, wallClockToUtc, type WallClock } from './tz';
import {
	buildRRuleString,
	expandToInstances,
	isoToKey,
	keyToWall,
	occurrenceExists,
	wallKey,
	type VEventData
} from './ics';

/**
 * Editing a whole recurring series ("All events") from one of its
 * occurrences.
 *
 * The rule: the occurrence the user opened is the reference point, never the
 * series' new anchor. Whatever they changed about it is applied to the series
 * as a difference —
 *
 *  - text, reminders, guests, status: only the fields that differ from the
 *    occurrence are written, to the master and to every override; the rest
 *    stay as they were;
 *  - the clock: DTSTART moves by the wall-clock delta the occurrence moved
 *    (measured in the series' own zone, so DST alignment survives a browser
 *    elsewhere), the duration changes only if the occurrence's did, and
 *    EXDATE, RDATE and every override (RECURRENCE-ID and its own DTSTART)
 *    move by that same delta, so each exception keeps naming the occurrence
 *    it belonged to — what Apple Calendar's "Change All" does;
 *  - the rule: kept verbatim unless the recurrence controls were touched
 *    (`payload.keepRecurrence`), with its day anchors (BYDAY, BYMONTHDAY,
 *    BYMONTH) following the new DTSTART when the date moved. An override
 *    that no longer lands on a generated occurrence is dropped rather than
 *    left as a stray event.
 *
 * Two edits cannot carry exceptions across and reset them, as Google does:
 * switching between all-day and timed (the keys change kind) and removing
 * the recurrence altogether.
 */

const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

/** A wall clock as a plain number (its fields read as UTC), so shifts are arithmetic. */
export function naiveMs(wc: WallClock): number {
	return Date.UTC(wc.year, wc.month - 1, wc.day, wc.hour, wc.minute, wc.second);
}

function fromNaiveMs(ms: number): WallClock {
	const d = new Date(ms);
	return {
		year: d.getUTCFullYear(),
		month: d.getUTCMonth() + 1,
		day: d.getUTCDate(),
		hour: d.getUTCHours(),
		minute: d.getUTCMinutes(),
		second: d.getUTCSeconds()
	};
}

export function shiftWall(wc: WallClock, deltaMs: number): WallClock {
	return fromNaiveMs(naiveMs(wc) + deltaMs);
}

/** Shift a wall key (`YYYYMMDD` or `YYYYMMDDTHHMMSS`) by a wall-clock delta. */
export function shiftKey(key: string, deltaMs: number): string {
	const wc = keyToWall(key);
	return wc ? wallKey(shiftWall(wc, deltaMs), key.length === 8) : key;
}

function dateMs(wc: WallClock): number {
	return Date.UTC(wc.year, wc.month - 1, wc.day);
}

function sameDate(a: WallClock, b: WallClock): boolean {
	return dateMs(a) === dateMs(b);
}

function weekday(wc: WallClock): number {
	return new Date(dateMs(wc)).getUTCDay();
}

/**
 * Move an RRULE's day anchors from one DTSTART to another the way the series
 * itself moves: a WEEKLY BYDAY rotates by the weekday difference (MO,WE,FR
 * dragged a day later → TU,TH,SA, every occurrence one day later), a
 * MONTHLY/YEARLY BYDAY on the old weekday follows it (3TU → 3WE; the ordinal
 * follows too when the week of the month changed), BYMONTHDAY and a YEARLY
 * BYMONTH equal to the old anchor follow as well. DAILY's BYDAY is a filter
 * ("weekdays only"), not an anchor, and stays. Everything else is untouched.
 */
export function shiftRRuleAnchors(raw: string, from: WallClock, to: WallClock): string {
	if (sameDate(from, to)) return raw;
	const parts = raw.split(';');
	const freq = parts.find((p) => /^FREQ=/i.test(p))?.slice(5).toUpperCase() ?? '';
	const rotation = (weekday(to) - weekday(from) + 7) % 7;
	const fromOrdinal = Math.ceil(from.day / 7);
	const toOrdinal = Math.ceil(to.day / 7);
	const mapEntries = (part: string, f: (entry: string) => string) => {
		const eq = part.indexOf('=');
		return `${part.slice(0, eq + 1)}${part.slice(eq + 1).split(',').map(f).join(',')}`;
	};
	return parts
		.map((part) => {
			const name = part.slice(0, part.indexOf('=')).toUpperCase();
			if (name === 'BYDAY' && freq !== 'DAILY') {
				return mapEntries(part, (entry) => {
					const m = /^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/i.exec(entry);
					if (!m) return entry;
					const ordinal = m[1] ?? '';
					const day = DAYS.indexOf(m[2].toUpperCase());
					if (freq === 'WEEKLY') return `${ordinal}${DAYS[(day + rotation) % 7]}`;
					if (day !== weekday(from)) return entry;
					const nextOrdinal = Number(ordinal) > 0 && Number(ordinal) === fromOrdinal ? String(toOrdinal) : ordinal;
					return `${nextOrdinal}${DAYS[weekday(to)]}`;
				});
			}
			if (name === 'BYMONTHDAY') return mapEntries(part, (v) => (Number(v) === from.day ? String(to.day) : v));
			if (name === 'BYMONTH' && freq === 'YEARLY') {
				return mapEntries(part, (v) => (Number(v) === from.month ? String(to.month) : v));
			}
			return part;
		})
		.join(';');
}

/**
 * Attendees as the client sends them (often bare addresses) over what the
 * server already knows about each: name, RSVP (PARTSTAT) and role are not
 * things an edit should reset.
 */
export function mergeAttendees(incoming: EventAttendee[], existing: EventAttendee[]): EventAttendee[] {
	const known = new Map(existing.map((a) => [a.email.toLowerCase(), a]));
	return incoming.map((a) => {
		const was = known.get(a.email.toLowerCase());
		if (!was) return a;
		return { email: a.email, name: a.name ?? was.name, partStat: a.partStat ?? was.partStat, role: a.role ?? was.role };
	});
}

/**
 * The RRULE for the tail of a series split at `slot`: a COUNT is reduced by
 * the occurrences the head used (EXDATEd ones count too, per RFC 5545), so
 * head and tail together still make the original count.
 */
export function tailRRule(master: VEventData, slot: WallClock): string | null {
	const raw = master.rruleRaw;
	if (!raw) return null;
	const m = /(^|;)COUNT=(\d+)/i.exec(raw);
	if (!m) return raw;
	const from = master.allDay ? dateMs(master.startWall) : wallClockToUtc(master.startWall, master.tzid);
	const to = master.allDay ? dateMs(slot) : wallClockToUtc(slot, master.tzid);
	const probe = { master: { ...master, exdates: [] }, overrides: [], method: null };
	const used = expandToInstances(probe, '', '', from - 1, to).length;
	return raw.replace(/(^|;)COUNT=\d+/i, `$1COUNT=${Math.max(1, Number(m[2]) - used)}`);
}

/** How far the user moved the occurrence, as a wall-clock delta in the master's zone. */
function wallDelta(seen: VEventData, edited: VEventData, master: VEventData): number {
	// All-day events have no clock, and an all-day ↔ timed switch keeps only the date.
	if (master.allDay || edited.allDay) return dateMs(edited.startWall) - dateMs(seen.startWall);
	const before = wallClockToUtc(seen.startWall, seen.tzid);
	const after = wallClockToUtc(edited.startWall, edited.tzid);
	return naiveMs(utcToWallClock(after, master.tzid)) - naiveMs(utcToWallClock(before, master.tzid));
}

function movedStart(master: VEventData, edited: VEventData, deltaMs: number, allDayChanged: boolean): WallClock {
	const shifted = shiftWall(master.startWall, deltaMs);
	if (!allDayChanged) return shifted;
	// Only the date carries across an all-day ↔ timed switch; a timed start
	// takes the clock the user chose.
	const { hour, minute, second } = edited.allDay ? { hour: 0, minute: 0, second: 0 } : edited.startWall;
	return { ...shifted, hour, minute, second };
}

export interface SeriesEdit {
	master: VEventData;
	overrides: VEventData[];
}

/**
 * Apply an "All events" edit. `edited` is the payload as VEventData (its start
 * is the edited occurrence's, in the browser's zone); `recurrenceId` names the
 * occurrence the user opened.
 */
export function applySeriesEdit(
	master: VEventData,
	overrides: VEventData[],
	edited: VEventData,
	payload: EventWritePayload,
	recurrenceId: string | null
): SeriesEdit {
	const key = recurrenceId ? isoToKey(recurrenceId) : null;
	const override = key ? (overrides.find((o) => o.recurrenceId === key) ?? null) : null;
	// What the user saw before editing: the override's own data, else the
	// master at that slot. Without a recurrenceId the first occurrence is it.
	const seen: VEventData = override ?? { ...master, startWall: (key && keyToWall(key)) || master.startWall };

	const allDayChanged = edited.allDay !== master.allDay;
	const deltaMs = wallDelta(seen, edited, master);
	const startWall = movedStart(master, edited, deltaMs, allDayChanged);
	const tzid = edited.allDay ? 'UTC' : allDayChanged ? edited.tzid : master.tzid;
	const dateMoved = !sameDate(master.startWall, startWall);

	const keepRule = payload.keepRecurrence === true || JSON.stringify(edited.rrule) === JSON.stringify(master.rrule);
	let rruleRaw = master.rruleRaw;
	if (!keepRule) rruleRaw = edited.rrule ? buildRRuleString(edited.rrule, edited.allDay, tzid) : null;
	else if (rruleRaw && dateMoved) rruleRaw = shiftRRuleAnchors(rruleRaw, master.startWall, startWall);

	// Only what differs from the occurrence the user looked at is an edit.
	const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
	const emails = (list: EventAttendee[]) => list.map((a) => a.email.toLowerCase()).sort();
	const changed = {
		summary: edited.summary !== seen.summary,
		description: edited.description !== seen.description,
		location: edited.location !== seen.location,
		status: edited.status !== seen.status,
		alarms: !same([...edited.alarms].sort(), [...seen.alarms].sort()),
		attendees: !same(emails(edited.attendees), emails(seen.attendees))
	};
	const apply = (target: VEventData): VEventData => ({
		...target,
		...(changed.summary ? { summary: edited.summary } : {}),
		...(changed.description ? { description: edited.description } : {}),
		...(changed.location ? { location: edited.location } : {}),
		...(changed.status ? { status: edited.status } : {}),
		...(changed.alarms ? { alarms: edited.alarms } : {}),
		...(changed.attendees ? { attendees: mergeAttendees(edited.attendees, target.attendees) } : {})
	});

	const durationChanged = allDayChanged || edited.durationMs !== seen.durationMs || edited.durationDays !== seen.durationDays;
	const next: VEventData = {
		...apply(master),
		sequence: master.sequence + 1,
		allDay: edited.allDay,
		tzid,
		startWall,
		durationMs: durationChanged ? edited.durationMs : master.durationMs,
		durationDays: durationChanged ? edited.durationDays : master.durationDays,
		rrule: keepRule ? master.rrule : edited.rrule,
		rruleRaw,
		exdates: [],
		rdates: [],
		organizer: edited.organizer ?? master.organizer
	};

	const recurrenceRemoved = !keepRule && !edited.rrule;
	if (allDayChanged || recurrenceRemoved) return { master: next, overrides: [] };

	next.exdates = master.exdates.map((k) => shiftKey(k, deltaMs));
	next.rdates = master.rdates.map((k) => shiftKey(k, deltaMs));
	let kept = overrides.map((o) => ({
		...apply(o),
		recurrenceId: shiftKey(o.recurrenceId as string, deltaMs),
		startWall: shiftWall(o.startWall, deltaMs)
	}));
	if (rruleRaw !== master.rruleRaw) kept = kept.filter((o) => occurrenceExists(next, o.recurrenceId as string));
	return { master: next, overrides: kept };
}
