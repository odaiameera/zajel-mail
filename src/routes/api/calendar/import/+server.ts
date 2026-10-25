import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { userEmailFromAuth } from '$lib/server/user';
import { importIcs } from '$lib/server/calendar/import';
import { CalDAVError } from '$lib/server/calendar/caldav';

/**
 * Import one batch of an .ics file into a calendar. The browser cuts big
 * files into batches at component boundaries ($lib/calendar/import); each
 * batch is a complete VCALENDAR.
 */
export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.auth) return json({ error: 'Unauthorized' }, { status: 401 });
	const userEmail = userEmailFromAuth(locals.auth);

	const body = (await request.json().catch(() => null)) as { calendarId?: unknown; ics?: unknown } | null;
	const calendarId = typeof body?.calendarId === 'string' ? body.calendarId : '';
	const ics = typeof body?.ics === 'string' ? body.ics : '';
	if (!calendarId || !ics) {
		return json({ error: 'calendarId and ics are required' }, { status: 400 });
	}

	try {
		const result = await importIcs(locals.auth, userEmail, calendarId, ics);
		return json(result);
	} catch (err) {
		if (err instanceof CalDAVError && [404, 413, 422].includes(err.status)) {
			return json({ error: err.message }, { status: err.status });
		}
		const status = err instanceof CalDAVError ? err.status : 502;
		return json({ error: 'Failed to import events' }, { status });
	}
};
