import type { EventAttendee, EventWritePayload, RecurrenceRule, RRuleWeekday } from '$lib/calendar/types';
import { isCollectionId } from './caldav';
import { isValidTimeZone } from './tz';

const FREQS = new Set(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']);
const WEEKDAYS = new Set(['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']);
const PARTSTATS = new Set(['NEEDS-ACTION', 'ACCEPTED', 'DECLINED', 'TENTATIVE', 'DELEGATED']);
const ROLES = new Set(['CHAIR', 'REQ-PARTICIPANT', 'OPT-PARTICIPANT', 'NON-PARTICIPANT']);

/**
 * The recurrence model, field by field. Every value here is written into an
 * RRULE line verbatim, so nothing but the enumerated tokens and bounded
 * numbers may pass. Fields are set in the order `recurToRule` emits them:
 * the server compares the two models by their JSON text.
 */
function validateRRule(raw: unknown): RecurrenceRule | null | string {
	if (raw == null) return null;
	if (typeof raw !== 'object') return 'rrule must be an object';
	const r = raw as Partial<Record<keyof RecurrenceRule, unknown>>;
	if (typeof r.freq !== 'string' || !FREQS.has(r.freq)) return 'rrule.freq must be DAILY, WEEKLY, MONTHLY or YEARLY';
	const interval = r.interval ?? 1;
	if (!Number.isInteger(interval) || (interval as number) < 1 || (interval as number) > 999) return 'rrule.interval must be 1–999';
	const rule: RecurrenceRule = { freq: r.freq as RecurrenceRule['freq'], interval: interval as number };
	if (r.byDay != null) {
		if (!Array.isArray(r.byDay) || !r.byDay.every((d) => typeof d === 'string' && WEEKDAYS.has(d))) {
			return 'rrule.byDay must be weekday codes';
		}
		if (r.byDay.length) rule.byDay = r.byDay as RRuleWeekday[];
	}
	if (r.byDayOrdinal != null) {
		if (typeof r.byDayOrdinal !== 'string' || !/^-?[1-5](SU|MO|TU|WE|TH|FR|SA)$/.test(r.byDayOrdinal)) {
			return 'rrule.byDayOrdinal must be like 3TU or -1FR';
		}
		rule.byDayOrdinal = r.byDayOrdinal;
	}
	if (r.byMonthDay != null) {
		if (!Number.isInteger(r.byMonthDay) || (r.byMonthDay as number) < 1 || (r.byMonthDay as number) > 31) {
			return 'rrule.byMonthDay must be 1–31';
		}
		rule.byMonthDay = r.byMonthDay as number;
	}
	if (r.count != null) {
		if (!Number.isInteger(r.count) || (r.count as number) < 1 || (r.count as number) > 9999) return 'rrule.count must be 1–9999';
		rule.count = r.count as number;
	}
	if (r.until != null) {
		if (typeof r.until !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(r.until)) return 'rrule.until must be YYYY-MM-DD';
		rule.until = r.until;
	}
	return rule;
}

/**
 * An attendee as it can appear on an ATTENDEE line: the address, a display
 * name, and only the enumerated RSVP and role tokens. Anything else is
 * dropped here and refilled from the stored copy when the event is updated.
 */
function cleanAttendee(raw: unknown): EventAttendee | null {
	const a = raw as Partial<EventAttendee> | null;
	if (!a || typeof a !== 'object' || typeof a.email !== 'string') return null;
	const email = a.email.trim();
	if (!/^[^\s@;:,"]+@[^\s@;:,"]+$/.test(email)) return null;
	const out: EventAttendee = { email };
	if (typeof a.name === 'string' && a.name.trim()) out.name = a.name.replace(/[\r\n"]/g, '').trim().slice(0, 200);
	if (typeof a.partStat === 'string' && PARTSTATS.has(a.partStat.toUpperCase())) out.partStat = a.partStat.toUpperCase();
	if (typeof a.role === 'string' && ROLES.has(a.role.toUpperCase())) out.role = a.role.toUpperCase();
	return out;
}

/** Validate + normalize a client event payload. Returns an error string on failure. */
export function validatePayload(body: unknown): EventWritePayload | string {
	const p = body as Partial<EventWritePayload> | null;
	if (!p || typeof p !== 'object') return 'Invalid body';
	if (!p.calendarId || typeof p.calendarId !== 'string') return 'calendarId is required';
	if (!isCollectionId(p.calendarId)) return 'calendarId is invalid';
	if (typeof p.title !== 'string') return 'title is required';
	if (typeof p.start !== 'string' || typeof p.end !== 'string') return 'start/end are required';
	const allDay = !!p.allDay;
	if (allDay) {
		if (!/^\d{4}-\d{2}-\d{2}$/.test(p.start) || !/^\d{4}-\d{2}-\d{2}$/.test(p.end)) {
			return 'All-day events need YYYY-MM-DD start/end';
		}
	} else {
		if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(p.start) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(p.end)) {
			return 'Timed events need YYYY-MM-DDTHH:mm start/end';
		}
		if (!p.timeZone || typeof p.timeZone !== 'string' || !isValidTimeZone(p.timeZone)) {
			return 'A valid IANA timeZone is required';
		}
		if (p.end <= p.start) return 'End must be after start';
	}
	if (p.alarms && (!Array.isArray(p.alarms) || p.alarms.some((a) => typeof a !== 'number' || a < 0))) {
		return 'alarms must be minutes-before numbers';
	}
	if (p.attendees && !Array.isArray(p.attendees)) return 'attendees must be an array';
	const rrule = validateRRule(p.rrule);
	if (typeof rrule === 'string') return rrule;
	return {
		calendarId: p.calendarId,
		title: p.title.slice(0, 500),
		allDay,
		start: p.start,
		end: p.end,
		timeZone: p.timeZone ?? 'UTC',
		description: typeof p.description === 'string' ? p.description.slice(0, 10000) : '',
		location: typeof p.location === 'string' ? p.location.slice(0, 500) : '',
		rrule,
		keepRecurrence: p.keepRecurrence === true,
		alarms: (p.alarms ?? []).slice(0, 5).map((a) => Math.round(a)),
		attendees: (p.attendees ?? [])
			.map(cleanAttendee)
			.filter((a): a is EventAttendee => a !== null)
			.slice(0, 50),
		status: p.status === 'tentative' || p.status === 'cancelled' ? p.status : 'confirmed'
	};
}
