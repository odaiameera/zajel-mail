import type { AuthState } from '$lib/jmap/types';
import {
	createEvent,
	deleteEvent,
	getEventSummary,
	getEventsInRange,
	listCalendarsWithMeta
} from '$lib/server/calendar/service';
import { getDisplayName } from '$lib/server/db/queries/app-prefs';
import { localClock, parseLocalDate, parseLocalTime } from './local-time';
import { createPendingAction } from './store';
import type { AgentTool, ToolContext } from './tools';

/**
 * Calendar tools. Adding an event changes the calendar (and, with attendees,
 * sends them invitations), and deleting one can't be undone, so both wait
 * for a click: the card shows exactly what will happen, and only a
 * conversation the user is in can propose either.
 */

const ADDRESS = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;
/** The description goes out in the invitation, so it is kept short enough to read on the card. */
const DESCRIPTION_MAX = 1000;

function schema(properties: Record<string, unknown>, required: string[] = Object.keys(properties)) {
	return { type: 'object', properties, required, additionalProperties: false };
}

function str(value: unknown, max = 500): string {
	return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/** `value` cut to `max` characters, ending in an ellipsis when it was longer. */
function cut(value: unknown, max: number): string {
	const text = str(value, max + 1);
	return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

export interface EventDraft {
	calendarId: string;
	calendarName: string;
	title: string;
	allDay: boolean;
	start: string;
	end: string;
	timeZone: string;
	location: string;
	description: string;
	attendees: string[];
}

/** Check and complete what the model asked for, or say what's wrong. */
async function draftEvent(ctx: ToolContext, input: Record<string, unknown>): Promise<EventDraft | { error: string }> {
	const title = str(input.title, 300);
	const allDay = input.all_day === true;
	const start = str(input.start, 20);
	const end = str(input.end, 20);
	if (!title) return { error: 'The event needs a title' };
	// A moment that exists, not just the right shape: "2026-11-31T09:00"
	// would otherwise be written as 1 December without anyone noticing.
	const parse = allDay ? parseLocalDate : parseLocalTime;
	const unreal = [start, end].find((value) => !parse(value));
	if (unreal !== undefined) {
		return { error: `“${unreal}” is not a real ${allDay ? 'date; all-day start and end are YYYY-MM-DD' : 'local time; start and end are YYYY-MM-DDTHH:mm'}` };
	}
	if (end <= start) return { error: 'The end must be after the start' };
	const attendees = (Array.isArray(input.attendees) ? input.attendees : [])
		.filter((a): a is string => typeof a === 'string')
		.map((a) => a.trim().toLowerCase())
		.filter((a) => a && a !== ctx.userEmail.toLowerCase());
	const bad = attendees.find((a) => !ADDRESS.test(a));
	if (bad) return { error: `“${bad}” is not an email address` };

	const calendars = await listCalendarsWithMeta(ctx.auth, ctx.userEmail);
	const calendar =
		calendars.find((c) => c.id === input.calendar_id) ?? calendars.find((c) => c.isDefault) ?? calendars[0];
	if (!calendar) return { error: 'No calendar is available' };
	return {
		calendarId: calendar.id,
		calendarName: calendar.name,
		title,
		allDay,
		start,
		end,
		timeZone: ctx.timeZone,
		location: str(input.location, 300),
		description: cut(input.description, DESCRIPTION_MAX),
		attendees: [...new Set(attendees)].slice(0, 50)
	};
}

export function describeWhen(draft: Pick<EventDraft, 'allDay' | 'start' | 'end' | 'timeZone'>): string {
	if (draft.allDay) return draft.start === draft.end ? `${draft.start} · all day` : `${draft.start} – ${draft.end} · all day`;
	const sameDay = draft.start.slice(0, 10) === draft.end.slice(0, 10);
	const end = sameDay ? draft.end.slice(11) : draft.end.replace('T', ' ');
	return `${draft.start.replace('T', ' ')}–${end} (${draft.timeZone})`;
}

/** Create a confirmed draft in the calendar, from the account it was proposed in. */
export async function createDraftedEvent(
	auth: AuthState,
	userEmail: string,
	userId: string,
	draft: EventDraft
): Promise<string> {
	const { id } = await createEvent(
		auth,
		userEmail,
		{
			calendarId: draft.calendarId,
			title: draft.title,
			allDay: draft.allDay,
			start: draft.start,
			end: draft.end,
			timeZone: draft.timeZone,
			location: draft.location,
			description: draft.description,
			attendees: draft.attendees.map((email) => ({ email }))
		},
		getDisplayName(userId)
	);
	return id;
}

const listCalendars: AgentTool = {
	name: 'list_calendars',
	tier: 'read',
	description: 'The user’s calendars, with ids for create_event.',
	input_schema: schema({}),
	async run(ctx) {
		const calendars = await listCalendarsWithMeta(ctx.auth, ctx.userEmail);
		return { content: calendars.map((c) => `id=${c.id} | ${c.name}${c.isDefault ? ' (default)' : ''}`).join('\n') || 'No calendars.' };
	}
};

const searchCalendar: AgentTool = {
	name: 'search_calendar',
	tier: 'read',
	description:
		'Events between two ISO dates or instants (after inclusive, before exclusive). A repeating event shows the occurrence key to pass to delete_event for just that one.',
	input_schema: schema({ after: { type: 'string' }, before: { type: 'string' } }),
	async run(ctx, input) {
		const from = Date.parse(str(input.after, 40));
		const to = Date.parse(str(input.before, 40));
		if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
			return { content: 'after and before must be dates with after first', isError: true };
		}
		const { events, partial } = await getEventsInRange(ctx.auth, ctx.userEmail, from, Math.min(to, from + 366 * 86_400_000));
		if (events.length === 0) return { content: partial ? 'No events found (some calendars failed to load).' : 'No events.' };
		return {
			content: events
				.slice(0, 60)
				.map((e) => {
					const occurrence = e.recurring && e.recurrenceId ? ` | occurrence=${e.recurrenceId}` : '';
					// On the user's clock, like every time the model reads.
					const start = localClock(e.start, ctx.timeZone);
					const end = localClock(e.end, ctx.timeZone);
					const when = e.allDay
						? `${start.slice(0, 10)} all day`
						: `${start} – ${start.slice(0, 10) === end.slice(0, 10) ? end.slice(11) : end}`;
					const line = `id=${e.id}${occurrence} | ${e.title} | ${when}${e.location ? ` | ${e.location}` : ''}`;
					return `<untrusted_event id="${e.id}">\n${line.replace(/<\/?untrusted_/g, '')}\n</untrusted_event>`;
				})
				.join('\n')
		};
	}
};

const createEventTool: AgentTool = {
	name: 'create_event',
	tier: 'outward',
	description:
		'Add an event. Times are local to the user ("YYYY-MM-DDTHH:mm"; all-day: "YYYY-MM-DD", end exclusive). Nothing is added by this call: the user sees the event on a card and confirms it, and with attendees the invitations go out then. Say so in your reply.',
	input_schema: schema({
		title: { type: 'string' },
		start: { type: 'string' },
		end: { type: 'string' },
		all_day: { type: 'boolean' },
		location: { type: ['string', 'null'] },
		description: { type: ['string', 'null'] },
		attendees: { type: 'array', items: { type: 'string' } },
		calendar_id: { type: ['string', 'null'] }
	}),
	async run(ctx, input) {
		const draft = await draftEvent(ctx, input);
		if ('error' in draft) return { content: draft.error, isError: true };
		// The card shows the stored payload as it is, so what the user reads is
		// what is written, and what the attendees receive.
		const pending = createPendingAction({
			userId: ctx.userId,
			accountId: ctx.accountRowId,
			conversationId: ctx.conversationId,
			kind: 'create_event',
			payload: { ...draft }
		});
		const invites = draft.attendees.length ? `, with invitations to ${draft.attendees.join(', ')}` : '';
		return {
			content: `Waiting for the user to confirm “${draft.title}”, ${describeWhen(draft)}${invites}. Nothing is in the calendar yet.`,
			pending
		};
	}
};

const deleteEventTool: AgentTool = {
	name: 'delete_event',
	tier: 'outward',
	description:
		'Delete an event, or one occurrence of a repeating one (pass its occurrence key from search_calendar). It can’t be undone, so the user confirms it first.',
	input_schema: schema({ event_id: { type: 'string' }, occurrence: { type: ['string', 'null'] } }),
	async run(ctx, input) {
		const id = str(input.event_id, 2000);
		const occurrence = str(input.occurrence, 40) || null;
		const event = id ? await getEventSummary(ctx.auth, ctx.userEmail, id).catch(() => null) : null;
		if (!event) return { content: 'No such event', isError: true };
		const pending = createPendingAction({
			userId: ctx.userId,
			accountId: ctx.accountRowId,
			conversationId: ctx.conversationId,
			kind: 'delete_event',
			payload: { eventId: id, occurrence: event.recurring ? occurrence : null, title: event.title, when: event.when, recurring: event.recurring }
		});
		return {
			content: `Waiting for the user to confirm deleting “${event.title}”${event.recurring ? (occurrence ? ' (that occurrence only)' : ' (the whole series)') : ''}. Nothing has been deleted.`,
			pending
		};
	}
};

/** Run a confirmed delete: one occurrence, or the whole event. */
export async function deleteConfirmedEvent(auth: AuthState, userEmail: string, payload: Record<string, unknown>): Promise<string> {
	const id = typeof payload.eventId === 'string' ? payload.eventId : '';
	const occurrence = typeof payload.occurrence === 'string' ? payload.occurrence : null;
	await deleteEvent(auth, userEmail, id, occurrence ? 'instance' : 'all', occurrence);
	return `Deleted “${String(payload.title ?? 'the event')}”${occurrence ? ' (that occurrence)' : ''}`;
}

export const CALENDAR_TOOLS: AgentTool[] = [listCalendars, searchCalendar, createEventTool, deleteEventTool];
