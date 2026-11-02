/**
 * Calendar changes the agent proposes and the user confirms.
 *
 * Reading mail is recoverable if the agent gets it wrong. Writing to a
 * calendar is not — a deleted event is gone, and an invented meeting is
 * something other people see. So the agent never writes directly. It produces
 * a proposal, the panel shows exactly what would happen, and the write only
 * runs after an explicit click. This mirrors how task creation already works
 * (see `/api/ai/tasks`), and keeps the promise the README makes.
 *
 * This module is the validation boundary. Everything here is pure so it can be
 * tested without a CalDAV server, and so the rules that decide what reaches
 * the calendar are readable in one place.
 */

export type CalendarAction = 'create' | 'delete';

/** A new event, in the shape `EventWritePayload` needs. */
export interface ProposedEvent {
	title: string;
	/** Timed: `YYYY-MM-DDTHH:mm` wall clock. All-day: `YYYY-MM-DD`. */
	start: string;
	/** Same format as start; exclusive for all-day. */
	end: string;
	allDay: boolean;
	timeZone: string;
	location: string;
	description: string;
	/** null means "the default calendar" — resolved server-side at confirm time. */
	calendarId: string | null;
}

/**
 * The event a delete would remove, resolved from the calendar rather than
 * from the model. The title and start are shown on the confirmation card, so
 * the user is agreeing to a specific event and not to an opaque id.
 */
export interface ProposedDeletion {
	id: string;
	title: string;
	/** Human-readable start in the event's own zone; the card prints it verbatim. */
	start: string;
	/**
	 * The one occurrence this is about when the event repeats (the id is
	 * shared by every occurrence of a series). Null means the whole object —
	 * which the confirm route refuses for a repeating event.
	 */
	recurrenceId: string | null;
}

export interface CalendarProposal {
	action: CalendarAction;
	/** One-line description for the confirmation card. */
	summary: string;
	event: ProposedEvent | null;
	target: ProposedDeletion | null;
}

/** Wall-clock local time, no zone — what EventWritePayload expects. */
const LOCAL_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const EVENT_PROPOSAL_SCHEMA = {
	type: 'object',
	properties: {
		action: { type: 'string', enum: ['create', 'delete'] },
		title: { type: ['string', 'null'] },
		start: { type: ['string', 'null'] },
		end: { type: ['string', 'null'] },
		allDay: { type: 'boolean' },
		location: { type: ['string', 'null'] },
		description: { type: ['string', 'null'] },
		calendarId: { type: ['string', 'null'] },
		eventId: { type: ['string', 'null'] }
	},
	required: ['action', 'title', 'start', 'end', 'allDay', 'location', 'description', 'calendarId', 'eventId']
};

function text(value: unknown, maxLength: number): string {
	return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

/** True when the value matches the format implied by `allDay`. */
function validInstant(value: string, allDay: boolean): boolean {
	return allDay ? LOCAL_DATE.test(value) : LOCAL_DATETIME.test(value);
}

/** IANA zone check by asking Intl, which is the same thing CalDAV will need. */
export function validTimeZone(zone: string): boolean {
	if (!zone) return false;
	try {
		new Intl.DateTimeFormat('en', { timeZone: zone }).format();
		return true;
	} catch {
		return false;
	}
}

/**
 * Turn the model's JSON into a create proposal, or null if it is not
 * something safe to put in front of the user.
 *
 * Rejecting here rather than repairing is deliberate: a half-understood time
 * silently rounded into a real calendar entry is worse than the agent saying
 * it could not work out when the meeting should be.
 */
export function parseCreateProposal(raw: unknown, fallbackTimeZone: string): CalendarProposal | null {
	const source = (raw ?? {}) as Record<string, unknown>;

	const title = text(source.title, 200);
	if (!title) return null;

	const allDay = source.allDay === true;
	const start = text(source.start, 40);
	let end = text(source.end, 40);

	if (!validInstant(start, allDay)) return null;

	// A missing end is recoverable — an hour for timed events, the same day
	// for all-day ones — because the user still sees and confirms the result.
	if (!end) {
		end = allDay ? nextDay(start) : addHour(start);
	}
	if (!validInstant(end, allDay)) return null;
	// An end at or before the start would be rejected by CalDAV anyway, and
	// the model has clearly misunderstood the request.
	if (end <= start) return null;

	const timeZone = validTimeZone(fallbackTimeZone) ? fallbackTimeZone : 'UTC';

	return {
		action: 'create',
		summary: describeCreate(title, start, end, allDay),
		event: {
			title,
			start,
			end,
			allDay,
			timeZone,
			location: text(source.location, 300),
			description: text(source.description, 2000),
			calendarId: text(source.calendarId, 200) || null
		},
		target: null
	};
}

/** `YYYY-MM-DDTHH:mm` one hour later, staying in wall-clock terms. */
function addHour(start: string): string {
	const [date, time] = start.split('T');
	const [hours, minutes] = time.split(':').map(Number);
	// Anchored to UTC purely as arithmetic on the wall clock; no zone
	// conversion happens here, the string goes back out in the same form.
	const shifted = new Date(Date.UTC(2000, 0, 1, hours + 1, minutes));
	const rolledOver = hours + 1 >= 24;
	const hh = String(shifted.getUTCHours()).padStart(2, '0');
	const mm = String(shifted.getUTCMinutes()).padStart(2, '0');
	return `${rolledOver ? nextDay(date) : date}T${hh}:${mm}`;
}

function nextDay(date: string): string {
	const next = new Date(`${date}T00:00:00Z`);
	next.setUTCDate(next.getUTCDate() + 1);
	return next.toISOString().slice(0, 10);
}

function describeCreate(title: string, start: string, end: string, allDay: boolean): string {
	if (allDay) {
		// The stored end is exclusive; showing it as-is would read as a day
		// longer than the user asked for.
		const lastDay = previousDay(end);
		return lastDay === start
			? `Create all-day event “${title}” on ${start}`
			: `Create all-day event “${title}” from ${start} to ${lastDay}`;
	}
	return `Create “${title}” on ${start.slice(0, 10)} at ${start.slice(11)}–${end.slice(11)}`;
}

function previousDay(date: string): string {
	const previous = new Date(`${date}T00:00:00Z`);
	previous.setUTCDate(previous.getUTCDate() - 1);
	return previous.toISOString().slice(0, 10);
}

/**
 * Build a delete proposal from an event that was actually found on the
 * calendar.
 *
 * The caller resolves the event first; this never takes an id straight from
 * the model. A hallucinated id would otherwise reach the confirmation card as
 * a plausible-looking deletion of something that does not exist, or worse,
 * of a different event that happens to share the id.
 */
export function buildDeleteProposal(event: {
	id: string;
	title: string;
	start: string;
	allDay: boolean;
	recurrenceId?: string | null;
	timeZone?: string | null;
}): CalendarProposal {
	const title = event.title || '(untitled event)';
	const recurrenceId = event.recurrenceId ?? null;
	const when = describeStart(event.start, event.allDay, event.timeZone ?? null);
	return {
		action: 'delete',
		summary: `Delete ${recurrenceId ? 'one occurrence of ' : ''}“${title}” on ${when}`,
		event: null,
		target: {
			id: event.id,
			title,
			start: recurrenceId ? `${when} · this occurrence only` : when,
			recurrenceId
		}
	};
}

/**
 * An instance start as the user would say it: the date for an all-day event,
 * otherwise the local date and time in the event's zone. The raw value is a
 * UTC instant, which reads as the wrong day for an evening or early-morning
 * event anywhere but UTC.
 */
function describeStart(start: string, allDay: boolean, timeZone: string | null): string {
	if (allDay) return start.slice(0, 10);
	const at = new Date(start);
	if (isNaN(at.getTime())) return start;
	const zone = timeZone && validTimeZone(timeZone) ? timeZone : 'UTC';
	const text = new Intl.DateTimeFormat('en-GB', {
		timeZone: zone,
		year: 'numeric',
		month: 'short',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		hour12: false
	}).format(at);
	return `${text} (${zone})`;
}

const OCCURRENCE_ID = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2})?$/;

/**
 * Re-validate a proposal arriving from the browser at confirm time.
 *
 * The confirmation round-trips through the client, so what comes back is
 * untrusted input regardless of what was sent out. This is the last check
 * before a real calendar write.
 */
export function parseConfirmedProposal(raw: unknown, fallbackTimeZone: string): CalendarProposal | null {
	const source = (raw ?? {}) as Record<string, unknown>;

	if (source.action === 'delete') {
		const target = (source.target ?? {}) as Record<string, unknown>;
		const id = text(target.id, 300);
		if (!id) return null;
		const recurrenceId = text(target.recurrenceId, 40);
		return {
			action: 'delete',
			summary: text(source.summary, 300) || `Delete event ${id}`,
			event: null,
			target: {
				id,
				title: text(target.title, 200),
				start: text(target.start, 80),
				recurrenceId: OCCURRENCE_ID.test(recurrenceId) ? recurrenceId : null
			}
		};
	}

	if (source.action !== 'create') return null;

	const event = (source.event ?? {}) as Record<string, unknown>;
	// Re-run the same rules the proposal was built under, so a tampered or
	// stale payload cannot take a shortcut the original could not.
	const reparsed = parseCreateProposal(
		{
			title: event.title,
			start: event.start,
			end: event.end,
			allDay: event.allDay,
			location: event.location,
			description: event.description,
			calendarId: event.calendarId
		},
		typeof event.timeZone === 'string' && validTimeZone(event.timeZone)
			? event.timeZone
			: fallbackTimeZone
	);
	return reparsed;
}
