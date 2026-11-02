/**
 * Shared calendar types used by both the server (CalDAV/ICS layer) and the
 * client (views, modals). Times cross the wire in two shapes:
 *
 *  - Instances (server → client) carry UTC instants (`start` / `end` as ISO
 *    strings with `Z`). The browser renders them in its local timezone.
 *  - Write payloads (client → server) carry *wall-clock* values plus an IANA
 *    `timeZone`, because that's what iCalendar stores (`DTSTART;TZID=…`) and
 *    it's the only representation that survives DST transitions for
 *    recurring events.
 */

export interface CalendarInfo {
	/** URL-safe collection name — the last path segment of the DAV href. */
	id: string;
	name: string;
	color: string;
	hidden: boolean;
	/** True for the account's default calendar (cannot be deleted). */
	isDefault: boolean;
}

export type RecurrenceFreq = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';

/** ISO-8601 weekday abbreviations as used by RRULE BYDAY. */
export type RRuleWeekday = 'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA' | 'SU';

export interface RecurrenceRule {
	freq: RecurrenceFreq;
	/** Every N days/weeks/months/years. Defaults to 1. */
	interval: number;
	/** Weekly recurrence days, e.g. ['MO','WE','FR']. */
	byDay?: RRuleWeekday[];
	/** For monthly: repeat on this day-of-month (1–31). */
	byMonthDay?: number;
	/** For monthly: "third Tuesday" style — ordinal + weekday, e.g. '3TU' or '-1FR'. */
	byDayOrdinal?: string;
	/** Inclusive end date (wall-clock `YYYY-MM-DD`). Mutually exclusive with count. */
	until?: string;
	/** Stop after N occurrences. */
	count?: number;
}

export interface EventAttendee {
	email: string;
	name?: string;
	/** iCalendar PARTSTAT: NEEDS-ACTION | ACCEPTED | DECLINED | TENTATIVE. */
	partStat?: string;
	role?: string;
}

export type EventStatus = 'confirmed' | 'tentative' | 'cancelled';

/**
 * A single renderable occurrence. Recurring events are expanded server-side
 * into one instance per occurrence inside the requested range.
 */
export interface EventInstance {
	/** Opaque object id — base64url of the DAV href. Same for all instances of one recurring event. */
	id: string;
	calendarId: string;
	uid: string;
	title: string;
	description: string;
	location: string;
	/** UTC instant (ISO, `Z`). For all-day events: `YYYY-MM-DD`. */
	start: string;
	/** UTC instant (exclusive). For all-day events: exclusive `YYYY-MM-DD`. */
	end: string;
	allDay: boolean;
	/** True if this instance came from an RRULE/RDATE expansion. */
	recurring: boolean;
	/**
	 * Identifies this occurrence inside its recurring set — the original
	 * wall-clock start (`YYYY-MM-DDTHH:mm:ss` or `YYYY-MM-DD`). Needed to
	 * target "this event only" edits. Null for non-recurring events.
	 */
	recurrenceId: string | null;
	rrule: RecurrenceRule | null;
	/** Reminder triggers, minutes before start (positive numbers). */
	alarms: number[];
	status: EventStatus;
	attendees: EventAttendee[];
	organizer: string | null;
	/** IANA timezone the event was authored in (null for all-day/UTC). */
	timeZone: string | null;
}

/** Client → server payload for creating or rewriting an event. */
export interface EventWritePayload {
	calendarId: string;
	title: string;
	allDay: boolean;
	/**
	 * Timed events: wall-clock `YYYY-MM-DDTHH:mm` interpreted in `timeZone`.
	 * All-day events: `YYYY-MM-DD` (end is exclusive).
	 */
	start: string;
	end: string;
	/** IANA zone for timed events, e.g. 'Asia/Amman'. Ignored for all-day. */
	timeZone: string;
	description?: string;
	location?: string;
	rrule?: RecurrenceRule | null;
	/**
	 * Updates only: true when the recurrence controls were not touched, so the
	 * server keeps the stored RRULE verbatim. `rrule` is a lossy model (no
	 * BYMONTH, BYSETPOS, …); rebuilding a series from it reshapes rules the
	 * user never meant to change.
	 */
	keepRecurrence?: boolean;
	alarms?: number[];
	attendees?: EventAttendee[];
	status?: EventStatus;
}

/**
 * Colour used for a calendar that has none of its own.
 *
 * Deliberately a literal rather than the accent token: calendar colours are
 * data — they are stored per calendar, shown as swatches, and compared
 * against each other — so they must resolve to a concrete value in contexts
 * where a CSS variable cannot (inline `style` on canvas-drawn event blocks,
 * colour-picker equality checks). It matches the accent by choice; changing
 * the palette means changing this too, which is now one edit rather than five.
 */
export const DEFAULT_CALENDAR_COLOR = '#0969da';

/** Which occurrences a recurring-event edit/delete applies to. */
export type EditScope = 'instance' | 'following' | 'all';

export const WEEKDAY_CODES: RRuleWeekday[] = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

/** Human label for a recurrence rule, e.g. "Weekly on Mon, Wed". */
export function describeRRule(rule: RecurrenceRule | null): string {
	if (!rule) return 'Does not repeat';
	const every = rule.interval > 1 ? `Every ${rule.interval} ` : '';
	const names: Record<RRuleWeekday, string> = {
		MO: 'Mon', TU: 'Tue', WE: 'Wed', TH: 'Thu', FR: 'Fri', SA: 'Sat', SU: 'Sun'
	};
	let base: string;
	switch (rule.freq) {
		case 'DAILY':
			base = rule.interval > 1 ? `${every}days` : 'Daily';
			break;
		case 'WEEKLY': {
			const days = rule.byDay?.map((d) => names[d]).join(', ');
			base = rule.interval > 1 ? `${every}weeks` : 'Weekly';
			if (days) base += ` on ${days}`;
			break;
		}
		case 'MONTHLY':
			base = rule.interval > 1 ? `${every}months` : 'Monthly';
			if (rule.byDayOrdinal) {
				const m = rule.byDayOrdinal.match(/^(-?\d)(\w\w)$/);
				if (m) {
					const ord = { '1': 'first', '2': 'second', '3': 'third', '4': 'fourth', '-1': 'last' }[m[1]] ?? m[1];
					base += ` on the ${ord} ${names[m[2] as RRuleWeekday] ?? m[2]}`;
				}
			} else if (rule.byMonthDay) {
				base += ` on day ${rule.byMonthDay}`;
			}
			break;
		case 'YEARLY':
			base = rule.interval > 1 ? `${every}years` : 'Annually';
			break;
	}
	if (rule.until) base += `, until ${rule.until}`;
	else if (rule.count) base += `, ${rule.count} times`;
	return base;
}

/** The calendar's views, as they appear in its URL (`?view=`). */
export const CALENDAR_VIEWS = ['month', 'week', 'workweek', '3day', 'day'] as const;
export type CalendarView = (typeof CALENDAR_VIEWS)[number];

export function isCalendarView(value: unknown): value is CalendarView {
	return typeof value === 'string' && (CALENDAR_VIEWS as readonly string[]).includes(value);
}
