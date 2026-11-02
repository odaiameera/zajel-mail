import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { userEmailFromAuth } from '$lib/server/user';
import { createEvent, getEventsInRange } from '$lib/server/calendar/service';
import { CalDAVError } from '$lib/server/calendar/caldav';
import { validatePayload } from '$lib/server/calendar/validate';
import { getDisplayName } from '$lib/server/db/queries/app-prefs';

export const GET: RequestHandler = async ({ locals, url }) => {
	if (!locals.auth) return json({ error: 'Unauthorized' }, { status: 401 });
	const userEmail = userEmailFromAuth(locals.auth);

	const start = Date.parse(url.searchParams.get('start') ?? '');
	const end = Date.parse(url.searchParams.get('end') ?? '');
	if (isNaN(start) || isNaN(end) || end <= start) {
		return json({ error: 'start/end query params (ISO) are required' }, { status: 400 });
	}
	// Hard cap: 13 months per request keeps expansion bounded.
	if (end - start > 400 * 86400000) {
		return json({ error: 'Range too large' }, { status: 400 });
	}

	try {
		const result = await getEventsInRange(locals.auth, userEmail, start, end);
		return json(result);
	} catch (err) {
		const status = err instanceof CalDAVError ? err.status : 502;
		return json({ error: 'Failed to load events' }, { status });
	}
};

export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.auth) return json({ error: 'Unauthorized' }, { status: 401 });
	const userEmail = userEmailFromAuth(locals.auth);

	const body = await request.json().catch(() => null);
	const payload = validatePayload(body);
	if (typeof payload === 'string') return json({ error: payload }, { status: 400 });

	try {
		const displayName = locals.user ? getDisplayName(locals.user.id) : null;
		const { id } = await createEvent(locals.auth, userEmail, payload, displayName);
		return json({ success: true, id });
	} catch (err) {
		const status = err instanceof CalDAVError ? err.status : 502;
		return json({ error: 'Failed to create event' }, { status });
	}
};
