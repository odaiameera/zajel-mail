import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { userEmailFromAuth } from '$lib/server/user';
import { deleteEvent, updateEvent } from '$lib/server/calendar/service';
import { CalDAVError } from '$lib/server/calendar/caldav';
import { validatePayload } from '$lib/server/calendar/validate';
import type { EditScope } from '$lib/calendar/types';
import { getDisplayName } from '$lib/server/db/queries/app-prefs';

function parseScope(value: unknown): EditScope {
	return value === 'instance' || value === 'following' ? value : 'all';
}

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	if (!locals.auth) return json({ error: 'Unauthorized' }, { status: 401 });
	const userEmail = userEmailFromAuth(locals.auth);

	const body = (await request.json().catch(() => null)) as {
		event?: unknown;
		scope?: string;
		recurrenceId?: string;
	} | null;
	if (!body) return json({ error: 'Invalid body' }, { status: 400 });

	const payload = validatePayload(body.event);
	if (typeof payload === 'string') return json({ error: payload }, { status: 400 });

	const scope = parseScope(body.scope);
	const recurrenceId = typeof body.recurrenceId === 'string' ? body.recurrenceId : null;
	if ((scope === 'instance' || scope === 'following') && !recurrenceId) {
		return json({ error: 'recurrenceId is required for this scope' }, { status: 400 });
	}

	try {
		const displayName = locals.user ? getDisplayName(locals.user.id) : null;
		const result = await updateEvent(
			locals.auth,
			userEmail,
			params.id,
			payload,
			scope,
			recurrenceId,
			displayName
		);
		return json({ success: true, id: result.id });
	} catch (err) {
		if (err instanceof CalDAVError && err.status === 412) {
			return json({ error: 'Event changed on the server — reload and try again' }, { status: 409 });
		}
		// A 409 from the service names its own conflict (e.g. the target
		// calendar already holds this event).
		if (err instanceof CalDAVError && err.status === 409) return json({ error: err.message }, { status: 409 });
		const status = err instanceof CalDAVError ? err.status : 502;
		return json({ error: 'Failed to update event' }, { status });
	}
};

export const DELETE: RequestHandler = async ({ locals, params, url }) => {
	if (!locals.auth) return json({ error: 'Unauthorized' }, { status: 401 });
	const userEmail = userEmailFromAuth(locals.auth);

	const scope = parseScope(url.searchParams.get('scope'));
	const recurrenceId = url.searchParams.get('recurrenceId');
	if ((scope === 'instance' || scope === 'following') && !recurrenceId) {
		return json({ error: 'recurrenceId is required for this scope' }, { status: 400 });
	}

	try {
		await deleteEvent(locals.auth, userEmail, params.id, scope, recurrenceId);
		return json({ success: true });
	} catch (err) {
		const status = err instanceof CalDAVError ? err.status : 502;
		return json({ error: 'Failed to delete event' }, { status });
	}
};
