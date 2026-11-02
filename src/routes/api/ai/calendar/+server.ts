import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { userEmailFromAuth } from '$lib/server/user';
import { getDisplayName } from '$lib/server/db/queries/app-prefs';
import {
	parseConfirmedProposal,
	validTimeZone
} from '$lib/server/ai/calendar-actions';
import {
	createEvent,
	deleteEvent,
	getEventSummary,
	listCalendarsWithMeta
} from '$lib/server/calendar/service';

/**
 * Apply a calendar change the user has confirmed.
 *
 * The agent never reaches this route on its own — it produces a proposal, the
 * panel renders it, and only a click sends it here. `confirmed: true` is
 * required for the same reason `/api/ai/tasks` requires it: the request body
 * arrives from a browser and nothing about it should be assumed.
 *
 * The proposal is re-validated here rather than trusted, because it made a
 * round trip through the client after the server built it.
 */
export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.auth) return json({ error: 'Unauthorized' }, { status: 401 });

	const body = (await request.json().catch(() => null)) as {
		confirmed?: unknown;
		proposal?: unknown;
		timeZone?: unknown;
	} | null;

	if (body?.confirmed !== true) {
		return json({ error: 'Calendar changes require explicit confirmation' }, { status: 400 });
	}

	const fallbackZone =
		typeof body.timeZone === 'string' && validTimeZone(body.timeZone) ? body.timeZone : 'UTC';
	const proposal = parseConfirmedProposal(body.proposal, fallbackZone);
	if (!proposal) {
		return json({ error: 'That calendar change is not valid' }, { status: 400 });
	}

	const userEmail = userEmailFromAuth(locals.auth);

	try {
		if (proposal.action === 'delete') {
			const target = proposal.target!;
			// The event as the server has it, not as the proposal describes it:
			// a repeating event shares one id across every occurrence, so
			// deleting "the event" the model picked would delete the series.
			const stored = await getEventSummary(locals.auth, userEmail, target.id);
			if (!stored) {
				return json({ error: 'That event is no longer on your calendar' }, { status: 404 });
			}
			if (stored.recurring && !target.recurrenceId) {
				return json(
					{
						error:
							'This is a repeating event. Open it in the calendar to choose whether to delete one occurrence or the whole series.'
					},
					{ status: 409 }
				);
			}
			await deleteEvent(
				locals.auth,
				userEmail,
				target.id,
				target.recurrenceId ? 'instance' : 'all',
				target.recurrenceId
			);
			return json({
				success: true,
				message: `Deleted “${stored.title}”${target.recurrenceId ? ' (that occurrence only)' : ''} from your calendar.`
			});
		}

		const event = proposal.event!;

		// A calendar the account does not have would fail deep inside CalDAV
		// with a confusing error, so resolve it here: named calendar if it
		// exists, otherwise the default.
		const calendars = await listCalendarsWithMeta(locals.auth, userEmail);
		const chosen =
			calendars.find((calendar) => calendar.id === event.calendarId) ??
			calendars.find((calendar) => calendar.isDefault) ??
			calendars[0];
		if (!chosen) {
			return json({ error: 'No calendar is available to add this to' }, { status: 400 });
		}

		const { id } = await createEvent(
			locals.auth,
			userEmail,
			{
				calendarId: chosen.id,
				title: event.title,
				allDay: event.allDay,
				start: event.start,
				end: event.end,
				timeZone: event.timeZone,
				description: event.description,
				location: event.location
			},
			// Same source the calendar UI's own create route uses, so an event
			// added here carries the identical organizer name.
			locals.user ? getDisplayName(locals.user.id) : null
		);

		return json({
			success: true,
			id,
			message: `Added “${event.title}” to ${chosen.name}.`
		});
	} catch (error) {
		const status = (error as { status?: number })?.status;
		return json(
			{ error: 'The calendar change could not be applied' },
			{ status: typeof status === 'number' && status >= 400 && status < 500 ? status : 502 }
		);
	}
};
