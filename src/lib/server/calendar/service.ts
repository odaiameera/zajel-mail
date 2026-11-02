import { randomUUID } from 'node:crypto';
import type { AuthState } from '$lib/jmap/types';
import type {
	CalendarInfo,
	EditScope,
	EventInstance,
	EventWritePayload
} from '$lib/calendar/types';
import { DEFAULT_CALENDAR_COLOR } from '$lib/calendar/types';
import { LABEL_COLORS } from '$lib/constants/colors';
import {
	calendarHref,
	calendarIdFromHref,
	createCalendar,
	deleteObject,
	getObject,
	hrefToId,
	idToHref,
	listCalendars,
	putObject,
	queryEvents,
	resolveCalendarHome,
	syncCollection,
	CalDAVError
} from './caldav';
import {
	buildIcs,
	expandToInstances,
	isoToKey,
	keyToWall,
	parseIcs,
	payloadToData,
	untilValue,
	type VEventData
} from './ics';
import { applySeriesEdit, mergeAttendees, tailRRule } from './series';
import { getCalendarMetaForUser } from '../db/queries/calendar-meta';

/**
 * Calendar domain logic: merges DAV collections with SQLite presentation
 * meta, expands ICS objects into instances, and translates UI edits
 * (including recurring-event scopes) into object writes.
 */

const DEFAULT_CALENDAR_ID = 'default';

export async function listCalendarsWithMeta(
	auth: AuthState,
	userEmail: string
): Promise<CalendarInfo[]> {
	// Resolve the calendar home once (cached) before any href is built, so a
	// non-conventional principal path is healed for the whole request.
	await resolveCalendarHome(auth, userEmail);
	let calendars = await listCalendars(auth, userEmail);

	// First visit on a fresh account: make sure at least one calendar exists.
	if (calendars.length === 0) {
		try {
			await createCalendar(auth, userEmail, DEFAULT_CALENDAR_ID, 'Calendar');
			calendars = await listCalendars(auth, userEmail);
		} catch {
			// e.g. concurrent creation — surface whatever the second list finds.
			calendars = await listCalendars(auth, userEmail);
		}
	}

	const meta = getCalendarMetaForUser(userEmail);
	// Stable palette assignment: default calendar gets the brand accent,
	// the rest rotate through the swatch palette by sorted position.
	const sorted = [...calendars].sort((a, b) => a.id.localeCompare(b.id));
	return calendars.map((c) => {
		const m = meta.get(c.id);
		const idx = sorted.findIndex((s) => s.id === c.id);
		const isDefault = c.id === DEFAULT_CALENDAR_ID;
		const fallback = isDefault ? DEFAULT_CALENDAR_COLOR : LABEL_COLORS[(idx * 3 + 10) % LABEL_COLORS.length].hex;
		return {
			id: c.id,
			name: c.name,
			color: m?.color ?? fallback,
			hidden: m?.hidden ?? false,
			isDefault
		};
	});
}

export interface RangeResult {
	calendars: CalendarInfo[];
	events: EventInstance[];
	/**
	 * True when at least one calendar's query failed. Callers must surface
	 * this — silently rendering the survivors makes a transient server
	 * error look like the user's events were deleted.
	 */
	partial: boolean;
	/** First failure's reason (status/message), for the UI banner + logs. */
	errorDetail?: string;
}

export async function getEventsInRange(
	auth: AuthState,
	userEmail: string,
	rangeStartMs: number,
	rangeEndMs: number
): Promise<RangeResult> {
	const calendars = await listCalendarsWithMeta(auth, userEmail);
	const visible = calendars.filter((c) => !c.hidden);
	let partial = false;
	let errorDetail: string | undefined;

	const perCalendar = await Promise.all(
		visible.map(async (cal) => {
			try {
				const objects = await queryEvents(
					auth,
					calendarHref(userEmail, cal.id),
					rangeStartMs,
					rangeEndMs
				);
				const instances: EventInstance[] = [];
				for (const obj of objects) {
					try {
						const parsed = parseIcs(obj.ics);
						instances.push(
							...expandToInstances(parsed, hrefToId(obj.href), cal.id, rangeStartMs, rangeEndMs)
						);
					} catch (err) {
						// One unparseable object must never blank the calendar —
						// skip it and keep every other event in this collection.
						console.warn(`[calendar] skipped object ${obj.href}`, err);
					}
				}
				return instances;
			} catch (err) {
				console.warn(`[calendar] query failed for ${cal.id}`, err);
				partial = true;
				errorDetail ??= err instanceof Error ? err.message : String(err);
				return [] as EventInstance[];
			}
		})
	);

	const events = perCalendar.flat().sort((a, b) => {
		// All-day events first within a day, then by start.
		if (a.start < b.start) return -1;
		if (a.start > b.start) return 1;
		return Number(b.allDay) - Number(a.allDay);
	});
	return { calendars, events, partial, errorDetail };
}

function newObjectHref(userEmail: string, calendarId: string, uid: string): string {
	return `${calendarHref(userEmail, calendarId)}${encodeURIComponent(uid)}.ics`;
}

export async function createEvent(
	auth: AuthState,
	userEmail: string,
	payload: EventWritePayload,
	organizerName: string | null
): Promise<{ id: string }> {
	await resolveCalendarHome(auth, userEmail);
	const uid = randomUUID();
	const data = payloadToData(payload, uid, {
		organizer: payload.attendees?.length ? { email: userEmail, name: organizerName } : null
	});
	if (!data) throw new CalDAVError('Invalid event payload', 400);
	const href = newObjectHref(userEmail, payload.calendarId, uid);
	await putObject(auth, href, buildIcs(data), null);
	return { id: hrefToId(href) };
}

/**
 * Truncate a verbatim RRULE at `untilIso` (YYYY-MM-DD) without rebuilding it
 * from the lossy UI model — parts like BYSETPOS/BYMONTH/WKST survive, and
 * rules the UI can't represent at all still get truncated.
 */
function truncateRRuleRaw(raw: string, untilIso: string, allDay: boolean, tzid: string): string {
	const kept = raw.split(';').filter((p) => !/^(UNTIL|COUNT)=/i.test(p.trim()));
	return [...kept, `UNTIL=${untilValue(untilIso, allDay, tzid)}`].join(';');
}

export async function updateEvent(
	auth: AuthState,
	userEmail: string,
	id: string,
	payload: EventWritePayload,
	scope: EditScope,
	recurrenceId: string | null,
	organizerName: string | null
): Promise<{ id: string }> {
	await resolveCalendarHome(auth, userEmail);
	const href = idToHref(id, userEmail);
	if (!href) throw new CalDAVError('Unknown event', 404);
	const currentCalendarId = calendarIdFromHref(href, userEmail);
	const obj = await getObject(auth, href);
	const parsed = parseIcs(obj.ics);
	if (!parsed.master) throw new CalDAVError('Event has no editable component', 422);
	const master = parsed.master;

	if (scope === 'instance' && recurrenceId) {
		const key = isoToKey(recurrenceId);
		const existing = parsed.overrides.find((o) => o.recurrenceId === key) ?? master;
		const override = payloadToData(payload, master.uid, {
			recurrenceId: key,
			// RECURRENCE-ID must name the occurrence in the master's zone —
			// the editing browser's zone is irrelevant to which slot this is.
			ridTzid: master.tzid,
			ridIsDate: master.allDay,
			sequence: master.sequence,
			organizer: master.organizer
		});
		if (!override) throw new CalDAVError('Invalid event payload', 400);
		// Single-occurrence edits never carry their own recurrence.
		override.rrule = null;
		override.rruleRaw = null;
		// What the client doesn't send (RSVPs, names, TRANSP/CLASS) stays as
		// this occurrence had it.
		override.attendees = mergeAttendees(override.attendees, existing.attendees);
		override.transp = existing.transp;
		override.icalClass = existing.icalClass;
		const others = parsed.overrides.filter((o) => o.recurrenceId !== key);
		await putObject(auth, href, buildIcs(master, [...others, override]), obj.etag);
		return { id };
	}

	if (scope === 'following' && recurrenceId) {
		const key = isoToKey(recurrenceId);
		const splitDate = keyToDateMs(key);
		const slot = keyToWall(key) ?? master.startWall;
		// Truncate the original series to the day before the split point.
		const truncated: VEventData = {
			...master,
			sequence: master.sequence + 1,
			exdates: master.exdates.filter((e) => keyToDateMs(e) < splitDate),
			rdates: master.rdates.filter((e) => keyToDateMs(e) < splitDate)
		};
		const untilDate = new Date(splitDate - 86400000);
		const untilIso = untilDate.toISOString().slice(0, 10);
		const masterStartMs = Date.UTC(
			master.startWall.year,
			master.startWall.month - 1,
			master.startWall.day
		);
		if (master.rruleRaw) {
			truncated.rruleRaw = truncateRRuleRaw(master.rruleRaw, untilIso, master.allDay, master.tzid);
			if (master.rrule) truncated.rrule = { ...master.rrule, until: untilIso, count: undefined };
		}
		const keptOverrides = parsed.overrides.filter(
			(o) => keyToDateMs(o.recurrenceId as string) < splitDate
		);

		// The new series is the tail of the old one — same rule (a COUNT less
		// what the head used), same zone and organizer, the exceptions from the
		// split onwards — with the edit applied to it exactly as "All events"
		// applies one: relative to the occurrence the user opened, so nothing
		// re-anchors and no exception is lost (see series.ts).
		const newUid = randomUUID();
		const tail: VEventData = {
			...master,
			uid: newUid,
			startWall: slot,
			sequence: 0,
			created: null,
			rruleRaw: tailRRule(master, slot),
			exdates: master.exdates.filter((e) => keyToDateMs(e) >= splitDate),
			rdates: master.rdates.filter((e) => keyToDateMs(e) >= splitDate)
		};
		const laterOverrides = parsed.overrides
			.filter((o) => keyToDateMs(o.recurrenceId as string) >= splitDate)
			.map((o) => ({ ...o, uid: newUid }));
		const edited = payloadToData(payload, newUid, {
			organizer:
				master.organizer ??
				(payload.attendees?.length ? { email: userEmail, name: organizerName } : null)
		});
		if (!edited) throw new CalDAVError('Invalid event payload', 400);
		edited.attendees = mergeAttendees(edited.attendees, master.attendees);
		const split = applySeriesEdit(tail, laterOverrides, edited, payload, recurrenceId);
		const newHref = newObjectHref(userEmail, payload.calendarId || currentCalendarId || '', newUid);
		await putObject(auth, newHref, buildIcs(split.master, split.overrides), null);

		if (splitDate <= masterStartMs) {
			// Nothing left of the original series.
			await deleteObject(auth, href);
		} else {
			await putObject(auth, href, buildIcs(truncated, keptOverrides), obj.etag);
		}
		return { id: hrefToId(newHref) };
	}

	// scope === 'all' (also the path for non-recurring events)
	const edited = payloadToData(payload, master.uid, {
		sequence: master.sequence + 1,
		created: master.created,
		organizer:
			master.organizer ??
			(payload.attendees?.length ? { email: userEmail, name: organizerName } : null)
	});
	if (!edited) throw new CalDAVError('Invalid event payload', 400);
	edited.attendees = mergeAttendees(edited.attendees, master.attendees);
	// Properties the UI doesn't model travel through an edit untouched.
	edited.transp = master.transp;
	edited.icalClass = master.icalClass;

	let next = edited;
	let overrides: VEventData[] = [];
	if (master.rruleRaw || master.rdates.length > 0) {
		// A series is edited relative to the occurrence the user opened: the
		// payload's start is that occurrence's, never the series' new anchor.
		({ master: next, overrides } = applySeriesEdit(master, parsed.overrides, edited, payload, recurrenceId));
	}

	const targetCalendarId = payload.calendarId || currentCalendarId || '';
	if (currentCalendarId && targetCalendarId !== currentCalendarId) {
		// Calendar move: write to the new collection, then remove the old object.
		const newHref = newObjectHref(userEmail, targetCalendarId, master.uid || randomUUID());
		await putObject(auth, newHref, buildIcs(next, overrides), null);
		await deleteObject(auth, href);
		return { id: hrefToId(newHref) };
	}

	await putObject(auth, href, buildIcs(next, overrides), obj.etag);
	return { id };
}

/**
 * What an event is, read from the server rather than from whoever names it:
 * a confirmation card shows this, not the model's description.
 */
export async function getEventSummary(
	auth: AuthState,
	userEmail: string,
	id: string
): Promise<{ title: string; when: string; recurring: boolean } | null> {
	await resolveCalendarHome(auth, userEmail);
	const href = idToHref(id, userEmail);
	if (!href) return null;
	const master = parseIcs((await getObject(auth, href)).ics).master;
	if (!master) return null;
	const w = master.startWall;
	const p = (n: number) => String(n).padStart(2, '0');
	const date = `${w.year}-${p(w.month)}-${p(w.day)}`;
	return {
		title: master.summary || '(no title)',
		when: master.allDay ? `${date} · all day` : `${date} ${p(w.hour)}:${p(w.minute)} (${master.tzid})`,
		recurring: !!master.rruleRaw
	};
}

export async function deleteEvent(
	auth: AuthState,
	userEmail: string,
	id: string,
	scope: EditScope,
	recurrenceId: string | null
): Promise<void> {
	await resolveCalendarHome(auth, userEmail);
	const href = idToHref(id, userEmail);
	if (!href) throw new CalDAVError('Unknown event', 404);

	if (scope === 'all' || !recurrenceId) {
		await deleteObject(auth, href);
		return;
	}

	const obj = await getObject(auth, href);
	const parsed = parseIcs(obj.ics);
	if (!parsed.master) {
		await deleteObject(auth, href);
		return;
	}
	const master = parsed.master;
	const key = isoToKey(recurrenceId);

	if (scope === 'instance') {
		const next: VEventData = {
			...master,
			sequence: master.sequence + 1,
			exdates: master.exdates.includes(key) ? master.exdates : [...master.exdates, key]
		};
		const overrides = parsed.overrides.filter((o) => o.recurrenceId !== key);
		await putObject(auth, href, buildIcs(next, overrides), obj.etag);
		return;
	}

	// scope === 'following'
	const splitDate = keyToDateMs(key);
	const masterStartMs = Date.UTC(
		master.startWall.year,
		master.startWall.month - 1,
		master.startWall.day
	);
	if (splitDate <= masterStartMs) {
		await deleteObject(auth, href);
		return;
	}
	const untilIso = new Date(splitDate - 86400000).toISOString().slice(0, 10);
	const next: VEventData = {
		...master,
		sequence: master.sequence + 1,
		exdates: master.exdates.filter((e) => keyToDateMs(e) < splitDate),
		rdates: master.rdates.filter((e) => keyToDateMs(e) < splitDate)
	};
	if (master.rruleRaw) {
		next.rruleRaw = truncateRRuleRaw(master.rruleRaw, untilIso, master.allDay, master.tzid);
		if (master.rrule) next.rrule = { ...master.rrule, until: untilIso, count: undefined };
	}
	const overrides = parsed.overrides.filter((o) => keyToDateMs(o.recurrenceId as string) < splitDate);
	await putObject(auth, href, buildIcs(next, overrides), obj.etag);
}

/** Calendar-date milliseconds (UTC midnight) of a wall key — used for split comparisons. */
function keyToDateMs(key: string): number {
	return Date.UTC(+key.slice(0, 4), +key.slice(4, 6) - 1, +key.slice(6, 8));
}

// ---------------------------------------------------------------------------
// Change polling (notifications)
// ---------------------------------------------------------------------------

export interface ChangedEventSummary {
	id: string;
	calendarId: string;
	uid: string;
	title: string;
	/** Next upcoming occurrence start (UTC ISO or YYYY-MM-DD for all-day). */
	start: string;
	allDay: boolean;
}

export interface PollResult {
	tokens: Record<string, string>;
	/** Events created or modified since the supplied tokens. */
	changed: ChangedEventSummary[];
	/** True when this is the first poll (no notifications should fire). */
	initial: boolean;
}

const POLL_CHANGE_CAP = 20;

export async function pollCalendarChanges(
	auth: AuthState,
	userEmail: string,
	tokens: Record<string, string>
): Promise<PollResult> {
	const calendars = await listCalendarsWithMeta(auth, userEmail);
	const nextTokens: Record<string, string> = {};
	const changed: ChangedEventSummary[] = [];
	const hadAnyToken = Object.keys(tokens).length > 0;

	await Promise.all(
		calendars.map(async (cal) => {
			const href = calendarHref(userEmail, cal.id);
			try {
				const prev = tokens[cal.id] ?? null;
				const result = await syncCollection(auth, href, prev);
				if (result.token) nextTokens[cal.id] = result.token;

				// No previous token (first poll for this calendar) or token reset:
				// record the position but don't report a notification storm.
				if (!prev || result.reset) return;

				for (const ch of result.changed.slice(0, POLL_CHANGE_CAP)) {
					try {
						const obj = await getObject(auth, ch.href);
						const parsed = parseIcs(obj.ics);
						const data = parsed.master ?? parsed.overrides[0];
						if (!data) continue;
						const now = Date.now();
						// Prefer the next upcoming occurrence for the notification body.
						const horizon = now + 366 * 86400000;
						const instances = expandToInstances(
							parsed,
							hrefToId(ch.href),
							cal.id,
							now - 86400000,
							horizon
						);
						const upcoming =
							instances.find((i) => new Date(i.allDay ? `${i.start}T00:00:00Z` : i.start).getTime() >= now - 3600000) ??
							instances[0];
						changed.push({
							id: hrefToId(ch.href),
							calendarId: cal.id,
							uid: data.uid,
							title: data.summary || '(untitled event)',
							start: upcoming?.start ?? '',
							allDay: data.allDay
						});
					} catch {
						// Object may have been deleted between sync and fetch.
					}
				}
			} catch (err) {
				console.warn(`[calendar] sync failed for ${cal.id}`, err);
			}
		})
	);

	return { tokens: nextTokens, changed, initial: !hadAnyToken };
}

export interface ReminderItem {
	/** Stable dedupe key: uid + occurrence + lead time. */
	key: string;
	eventId: string;
	title: string;
	/** Occurrence start, UTC ISO (all-day occurrences use local-midnight semantics client-side). */
	start: string;
	allDay: boolean;
	/** Epoch ms when the reminder should fire. */
	fireAt: number;
	minutesBefore: number;
}

/** Reminders (VALARMs) firing within the next `horizonMs`. */
export async function upcomingReminders(
	auth: AuthState,
	userEmail: string,
	horizonMs: number
): Promise<ReminderItem[]> {
	const now = Date.now();
	const { events } = await getEventsInRange(auth, userEmail, now - 86400000, now + horizonMs + 86400000);
	const out: ReminderItem[] = [];
	for (const ev of events) {
		if (ev.alarms.length === 0) continue;
		const startMs = ev.allDay ? new Date(`${ev.start}T00:00:00`).getTime() : new Date(ev.start).getTime();
		for (const minutes of ev.alarms) {
			const fireAt = startMs - minutes * 60000;
			if (fireAt < now - 5 * 60000 || fireAt > now + horizonMs) continue;
			out.push({
				key: `${ev.uid}:${ev.recurrenceId ?? ''}:${minutes}`,
				eventId: ev.id,
				title: ev.title || '(untitled event)',
				start: ev.start,
				allDay: ev.allDay,
				fireAt,
				minutesBefore: minutes
			});
		}
	}
	return out.sort((a, b) => a.fireAt - b.fireAt);
}
