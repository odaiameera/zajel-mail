import ICAL from 'ical.js';
import { randomUUID } from 'node:crypto';
import type { AuthState } from '$lib/jmap/types';
import { calendarHref, listCalendars, putObject, resolveCalendarHome, CalDAVError } from './caldav';
import { parseIcs } from './ics';

/**
 * Importing an .ics file (an exported calendar or a single event) into one
 * of the user's calendars. CalDAV stores one object per UID, so the file is
 * split by UID — a recurring series travels with its overrides — and each
 * object carries the VTIMEZONEs its times refer to. The iTIP METHOD is
 * dropped (RFC 4791 §4.1). Objects are written unconditionally, so importing
 * the same file again updates its events instead of duplicating them.
 */

export interface ImportObject {
	uid: string;
	ics: string;
	/** First day of the event (YYYY-MM-DD), to show it after import. */
	day: string;
}

export interface SplitResult {
	objects: ImportObject[];
	/** VEVENTs that don't parse into a usable event. */
	invalid: number;
}

/** Most events one request may write. */
export const MAX_IMPORT_EVENTS = 500;
const CONCURRENCY = 4;
const PRODID = '-//Zajel Mail//Calendar import//EN';

function clone(comp: ICAL.Component): ICAL.Component {
	return new ICAL.Component(structuredClone(comp.toJSON()));
}

function referencedZones(events: ICAL.Component[]): Set<string> {
	const zones = new Set<string>();
	const visit = (comp: ICAL.Component) => {
		for (const prop of comp.getAllProperties()) {
			const tzid = prop.getParameter('tzid');
			if (typeof tzid === 'string') zones.add(tzid);
		}
		for (const sub of comp.getAllSubcomponents()) visit(sub);
	};
	for (const ev of events) visit(ev);
	return zones;
}

export function splitIcsForImport(ics: string): SplitResult {
	let parsed: unknown;
	try {
		parsed = ICAL.parse(ics);
	} catch {
		throw new CalDAVError('Could not read this calendar file', 422);
	}
	// One VCALENDAR parses to a jCal array; several to an array of them.
	const roots = (Array.isArray(parsed) && typeof parsed[0] === 'string' ? [parsed] : parsed) as unknown[];

	const objects: ImportObject[] = [];
	let invalid = 0;
	for (const root of roots) {
		const cal = new ICAL.Component(root as never);
		if (cal.name !== 'vcalendar') continue;
		const timezones = cal.getAllSubcomponents('vtimezone');

		const groups = new Map<string, ICAL.Component[]>();
		for (const vevent of cal.getAllSubcomponents('vevent')) {
			let uid = String(vevent.getFirstPropertyValue('uid') ?? '').trim();
			if (!uid) {
				uid = randomUUID();
				vevent.updatePropertyWithValue('uid', uid);
			}
			const list = groups.get(uid) ?? [];
			list.push(vevent);
			groups.set(uid, list);
		}

		for (const [uid, events] of groups) {
			const out = new ICAL.Component(['vcalendar', [], []]);
			out.updatePropertyWithValue('prodid', PRODID);
			out.updatePropertyWithValue('version', '2.0');
			const zones = referencedZones(events);
			for (const tz of timezones) {
				if (zones.has(String(tz.getFirstPropertyValue('tzid') ?? ''))) out.addSubcomponent(clone(tz));
			}
			for (const ev of events) out.addSubcomponent(clone(ev));

			const text = out.toString();
			const data = parseIcs(text);
			const first = data.master ?? data.overrides[0];
			if (!first) {
				invalid += events.length;
				continue;
			}
			const { year, month, day } = first.startWall;
			objects.push({
				uid,
				ics: text,
				day: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
			});
		}
	}
	return { objects, invalid };
}

export interface ImportResult {
	imported: number;
	failed: number;
	/** Day of the first imported event, for the calendar to open on. */
	firstDay: string | null;
}

export async function importIcs(
	auth: AuthState,
	userEmail: string,
	calendarId: string,
	ics: string
): Promise<ImportResult> {
	await resolveCalendarHome(auth, userEmail);
	const calendars = await listCalendars(auth, userEmail);
	if (!calendars.some((c) => c.id === calendarId)) {
		throw new CalDAVError('Calendar not found', 404);
	}

	const { objects, invalid } = splitIcsForImport(ics);
	if (objects.length > MAX_IMPORT_EVENTS) {
		throw new CalDAVError(`Import at most ${MAX_IMPORT_EVENTS} events at a time`, 413);
	}

	const base = calendarHref(userEmail, calendarId);
	let imported = 0;
	let failed = invalid;
	let firstDay: string | null = null;
	let next = 0;
	async function lane() {
		while (next < objects.length) {
			const obj = objects[next++];
			try {
				await putObject(auth, `${base}${encodeURIComponent(obj.uid)}.ics`, obj.ics, undefined);
				imported++;
				if (!firstDay || obj.day < firstDay) firstDay = obj.day;
			} catch {
				failed++;
			}
		}
	}
	await Promise.all(Array.from({ length: Math.min(CONCURRENCY, objects.length) }, lane));
	return { imported, failed, firstDay };
}
