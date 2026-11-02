import ICAL from 'ical.js';
import type { AuthState } from '$lib/jmap/types';
import type { CalendarInfo, EventAttendee, EventInstance, RecurrenceRule } from '$lib/calendar/types';
import { expandToInstances, keyToIso, parseIcs, parseOverride } from './ics';
import { wallClockToUtc } from './tz';
import {
	calendarHref,
	deleteObject,
	getObject,
	hrefToId,
	putObject,
	CalDAVError,
	type DavObject
} from './caldav';

/**
 * iMIP (RFC 6047) support: calendar invitations arrive as `text/calendar`
 * MIME parts with METHOD:REQUEST (or CANCEL for retractions). Everything
 * here is deterministic parsing — no inference involved.
 */

export interface InvitationSummary {
	uid: string;
	method: string | null;
	/**
	 * Set when the file is about ONE occurrence of a series — a VEVENT with a
	 * RECURRENCE-ID and no master, which is how organizers send a change to,
	 * or the cancellation of, a single meeting in a series. The client-facing
	 * occurrence id (`YYYY-MM-DD[THH:mm:ss]`).
	 */
	recurrenceId: string | null;
	event: {
		title: string;
		allDay: boolean;
		/** First relevant occurrence (next upcoming, else the first). UTC ISO / YYYY-MM-DD. */
		start: string;
		end: string;
		location: string;
		description: string;
		recurring: boolean;
		rrule: RecurrenceRule | null;
	};
	organizer: { email: string; name: string | null } | null;
	attendees: EventAttendee[];
	/** The user's PARTSTAT in the invitation itself (NEEDS-ACTION etc.), if they're an attendee. */
	myStatus: string | null;
}

function pickInstance(instances: EventInstance[]): EventInstance | null {
	if (instances.length === 0) return null;
	const now = Date.now();
	return (
		instances.find((i) => {
			const t = i.allDay ? Date.parse(`${i.start}T00:00:00Z`) : Date.parse(i.start);
			return t >= now - 3600000;
		}) ?? instances[0]
	);
}

/** Parse an invitation ICS into a renderable summary, or null if it has no usable VEVENT. */
export function summarizeInvitation(ics: string, userEmail: string): InvitationSummary | null {
	const parsed = parseIcs(ics);
	const data = parsed.master ?? parsed.overrides[0];
	if (!data || !data.uid) return null;

	// Expand around the event's own start so past events still summarize.
	const startMs = data.allDay
		? Date.UTC(data.startWall.year, data.startWall.month - 1, data.startWall.day)
		: wallClockToUtc(data.startWall, data.tzid);
	const instances = expandToInstances(parsed, 'x', 'x', startMs - 86400000, startMs + 400 * 86400000);
	const inst = pickInstance(instances);
	if (!inst) return null;

	const me = data.attendees.find((a) => a.email.toLowerCase() === userEmail.toLowerCase());

	return {
		uid: data.uid,
		method: parsed.method,
		recurrenceId: !parsed.master && data.recurrenceId ? keyToIso(data.recurrenceId) : null,
		event: {
			title: data.summary,
			allDay: inst.allDay,
			start: inst.start,
			end: inst.end,
			location: data.location,
			description: data.description,
			recurring: !!data.rruleRaw,
			rrule: data.rrule
		},
		organizer: data.organizer,
		attendees: data.attendees,
		myStatus: me?.partStat?.toUpperCase() ?? (me ? 'NEEDS-ACTION' : null)
	};
}

/**
 * Prepare an invitation for storage on the user's calendar: keep the
 * original bytes (VTIMEZONE, X-props and all) but strip the iTIP METHOD —
 * CalDAV object resources must not carry one (RFC 4791 §4.1) — and patch
 * the user's ATTENDEE PARTSTAT when they RSVP'd.
 */
export function patchInvitationForImport(
	ics: string,
	userEmail: string,
	partStat: string | null
): string | null {
	let comp: ICAL.Component;
	try {
		comp = new ICAL.Component(ICAL.parse(ics));
	} catch {
		return null;
	}
	comp.removeAllProperties('method');

	if (partStat) {
		const wanted = userEmail.toLowerCase();
		for (const vevent of comp.getAllSubcomponents('vevent')) {
			for (const prop of vevent.getAllProperties('attendee')) {
				const value = String(prop.getFirstValue() ?? '').toLowerCase();
				if (value === `mailto:${wanted}` || value === wanted) {
					prop.setParameter('partstat', partStat);
					prop.setParameter('rsvp', 'FALSE');
				}
			}
		}
	}
	return comp.toString();
}

function clone(comp: ICAL.Component): ICAL.Component {
	return new ICAL.Component(structuredClone(comp.toJSON()));
}

/**
 * Fold an invitation about ONE occurrence (an override-only file, see
 * {@link InvitationSummary.recurrenceId}) into the stored series. Replacing
 * the object instead — what a plain PUT does — would turn a whole series
 * into that one occurrence, or delete it for a cancellation.
 *
 * Byte-preserving like the import itself: the stored object is edited as
 * components, never regenerated. A REQUEST replaces the stored override for
 * that occurrence (or adds one); a CANCEL drops it and copies the organizer's
 * RECURRENCE-ID — zone and all — onto the master as an EXDATE. Returns null
 * when the stored copy has no master to fold into.
 */
export function mergeOccurrence(storedIcs: string, incomingIcs: string, method: string | null): string | null {
	let stored: ICAL.Component;
	let incoming: ICAL.Component;
	try {
		stored = new ICAL.Component(ICAL.parse(storedIcs));
		incoming = new ICAL.Component(ICAL.parse(incomingIcs));
	} catch {
		return null;
	}
	const master = parseIcs(storedIcs).master;
	const masterComp = stored.getAllSubcomponents('vevent').find((v) => !v.hasProperty('recurrence-id'));
	if (!master || !masterComp) return null;

	for (const inc of incoming.getAllSubcomponents('vevent')) {
		const ridProp = inc.getFirstProperty('recurrence-id');
		const data = parseOverride(inc, master);
		if (!ridProp || !data) continue;
		// Whatever the stored copy said about this occurrence is superseded.
		for (const v of [...stored.getAllSubcomponents('vevent')]) {
			if (v !== masterComp && parseOverride(v, master)?.recurrenceId === data.recurrenceId) {
				stored.removeSubcomponent(v);
			}
		}
		if (method === 'CANCEL' || data.status === 'cancelled') {
			const exdate = ridProp.toJSON() as unknown[];
			exdate[0] = 'exdate';
			masterComp.addProperty(new ICAL.Property(exdate));
		} else {
			stored.addSubcomponent(clone(inc));
		}
	}
	// Zones the incoming occurrence refers to that the stored object lacks.
	const have = new Set(stored.getAllSubcomponents('vtimezone').map((t) => String(t.getFirstPropertyValue('tzid') ?? '')));
	for (const tz of incoming.getAllSubcomponents('vtimezone')) {
		if (!have.has(String(tz.getFirstPropertyValue('tzid') ?? ''))) stored.addSubcomponent(clone(tz));
	}
	return stored.toString();
}

export interface ExistingCopy {
	calendarId: string;
	eventId: string;
	/** The user's PARTSTAT in the stored copy. */
	myStatus: string | null;
}

/** Look for an already-imported copy of `uid` across the user's calendars. */
export async function findExistingCopy(
	auth: AuthState,
	userEmail: string,
	uid: string,
	calendars: CalendarInfo[]
): Promise<ExistingCopy | null> {
	const results = await Promise.all(
		calendars.map(async (cal) => {
			const href = `${calendarHref(userEmail, cal.id)}${encodeURIComponent(uid)}.ics`;
			try {
				const obj = await getObject(auth, href);
				const parsed = parseIcs(obj.ics);
				const data = parsed.master ?? parsed.overrides[0];
				const me = data?.attendees.find((a) => a.email.toLowerCase() === userEmail.toLowerCase());
				return {
					calendarId: cal.id,
					eventId: hrefToId(href),
					myStatus: me?.partStat?.toUpperCase() ?? null
				};
			} catch {
				return null;
			}
		})
	);
	return results.find((r) => r !== null) ?? null;
}

/** The stored object at `href`, or null when there is none (other failures propagate). */
async function storedObject(auth: AuthState, href: string): Promise<DavObject | null> {
	try {
		return await getObject(auth, href);
	} catch (err) {
		if (err instanceof CalDAVError && err.status === 404) return null;
		throw err;
	}
}

/**
 * Import (or re-import with a new RSVP) an invitation into a calendar. A
 * file about one occurrence of a series the user already holds is folded
 * into that series; a cancellation of an occurrence removes just it.
 */
export async function importInvitation(
	auth: AuthState,
	userEmail: string,
	ics: string,
	calendarId: string,
	partStat: string | null
): Promise<{ eventId: string; uid: string }> {
	const summary = summarizeInvitation(ics, userEmail);
	if (!summary) throw new CalDAVError('No event found in this file', 422);
	const patched = patchInvitationForImport(ics, userEmail, partStat);
	if (!patched) throw new CalDAVError('Could not parse the calendar file', 422);

	const href = `${calendarHref(userEmail, calendarId)}${encodeURIComponent(summary.uid)}.ics`;
	const result = { eventId: hrefToId(href), uid: summary.uid };

	if (summary.recurrenceId) {
		const stored = await storedObject(auth, href);
		const merged = stored ? mergeOccurrence(stored.ics, patched, summary.method) : null;
		if (stored && merged) {
			// Conditional: a series changed from another device must not be
			// overwritten with a merge made against its previous version.
			await putObject(auth, href, merged, stored.etag);
			return result;
		}
		if (summary.method === 'CANCEL') {
			// Nothing to fold into — either the series isn't here, or what is
			// here is only this occurrence, which the organizer just cancelled.
			if (!stored) throw new CalDAVError('This event is not on your calendar', 404);
			await deleteObject(auth, href);
			return result;
		}
	}

	// Unconditional PUT: updated invitations (SEQUENCE bumps) and RSVP
	// changes overwrite the previous copy by design.
	await putObject(auth, href, patched, undefined);
	return result;
}

export interface ItipReply {
	/** METHOD:REPLY calendar, ready to mail. */
	ics: string;
	/** The organizer's address, the one recipient. */
	organizer: string;
	/** "Accepted: Weekly sync" — the subject Google, Outlook and Apple use. */
	subject: string;
}

const REPLY_WORD: Record<string, string> = { ACCEPTED: 'Accepted', TENTATIVE: 'Tentative', DECLINED: 'Declined' };

/**
 * The iTIP REPLY (RFC 5546 §3.2.3) for an RSVP: each invited VEVENT reduced
 * to what a reply carries — UID, RECURRENCE-ID, SEQUENCE, ORGANIZER, the
 * time, SUMMARY, and exactly one ATTENDEE, the user, with the new PARTSTAT —
 * plus the VTIMEZONEs those times refer to. Null when there is nobody to
 * tell: no ORGANIZER, the user isn't an attendee, or the user organizes it.
 */
export function buildReply(ics: string, userEmail: string, partStat: string): ItipReply | null {
	let comp: ICAL.Component;
	try {
		comp = new ICAL.Component(ICAL.parse(ics));
	} catch {
		return null;
	}
	const me = userEmail.toLowerCase();
	const address = (prop: ICAL.Property) => String(prop.getFirstValue() ?? '').replace(/^mailto:/i, '');
	const out = new ICAL.Component(['vcalendar', [], []]);
	out.updatePropertyWithValue('version', '2.0');
	out.updatePropertyWithValue('prodid', '-//Zajel Mail//webmail calendar//EN');
	out.updatePropertyWithValue('method', 'REPLY');

	let organizer: string | null = null;
	let summary = '';
	for (const vevent of comp.getAllSubcomponents('vevent')) {
		const mine = vevent.getAllProperties('attendee').find((p) => address(p).toLowerCase() === me);
		const org = vevent.getFirstProperty('organizer');
		if (!mine || !org) continue;
		organizer ??= address(org);
		summary ||= String(vevent.getFirstPropertyValue('summary') ?? '');

		const reply = new ICAL.Component('vevent');
		for (const name of ['uid', 'recurrence-id', 'sequence', 'organizer', 'dtstart', 'dtend', 'duration', 'summary']) {
			const prop = vevent.getFirstProperty(name);
			if (prop) reply.addProperty(new ICAL.Property(structuredClone(prop.toJSON())));
		}
		const attendee = new ICAL.Property(structuredClone(mine.toJSON()));
		attendee.setParameter('partstat', partStat);
		attendee.removeParameter('rsvp');
		reply.addProperty(attendee);
		reply.updatePropertyWithValue('dtstamp', ICAL.Time.fromJSDate(new Date(), true));
		out.addSubcomponent(reply);
	}
	if (!organizer || organizer.toLowerCase() === me || out.getAllSubcomponents('vevent').length === 0) return null;
	for (const tz of comp.getAllSubcomponents('vtimezone')) out.addSubcomponent(clone(tz));

	return {
		ics: out.toString(),
		organizer,
		subject: `${REPLY_WORD[partStat] ?? partStat}: ${summary || 'Invitation'}`
	};
}
