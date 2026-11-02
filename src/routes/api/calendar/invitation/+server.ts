import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { userEmailFromAuth } from '$lib/server/user';
import { importInvitation } from '$lib/server/calendar/imip';
import { sendItipReply, type ReplyOutcome } from '$lib/server/calendar/itip-reply';
import { CalDAVError } from '$lib/server/calendar/caldav';

const PARTSTATS = new Set(['ACCEPTED', 'TENTATIVE', 'DECLINED']);

/**
 * Add an emailed invitation to one of the user's calendars, optionally
 * recording their RSVP (PARTSTAT) in the stored copy. Re-importing the
 * same UID overwrites — that's how RSVP changes and SEQUENCE updates land.
 */
export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.auth) return json({ error: 'Unauthorized' }, { status: 401 });
	const userEmail = userEmailFromAuth(locals.auth);

	const body = (await request.json().catch(() => null)) as {
		blobId?: string;
		calendarId?: string;
		partStat?: string;
	} | null;
	if (!body?.blobId || !body?.calendarId) {
		return json({ error: 'blobId and calendarId are required' }, { status: 400 });
	}
	const partStat =
		body.partStat && PARTSTATS.has(body.partStat.toUpperCase())
			? body.partStat.toUpperCase()
			: null;

	const downloadUrl = `${locals.auth.apiUrl}download/${locals.auth.accountId}/${encodeURIComponent(body.blobId)}/invite.ics`;
	let ics: string;
	try {
		const res = await fetch(downloadUrl, {
			headers: { Authorization: locals.auth.authHeader }
		});
		if (!res.ok) return json({ error: `Download failed (${res.status})` }, { status: 502 });
		ics = await res.text();
	} catch {
		return json({ error: 'Download failed' }, { status: 502 });
	}

	let result: { eventId: string; uid: string };
	try {
		result = await importInvitation(locals.auth, userEmail, ics, body.calendarId, partStat);
	} catch (err) {
		if (err instanceof CalDAVError && err.status === 412) {
			return json({ error: 'Event changed on the server — reload and try again' }, { status: 409 });
		}
		const status = err instanceof CalDAVError ? err.status : 502;
		const message =
			err instanceof CalDAVError && (err.status === 422 || err.status === 404) ? err.message : 'Failed to add to calendar';
		return json({ error: message }, { status });
	}

	// An RSVP reaches the organizer by iMIP. The calendar already holds it,
	// so a failed send is reported, not fatal.
	let replied: ReplyOutcome = 'none';
	if (partStat) {
		try {
			replied = await sendItipReply(locals.auth, userEmail, ics, partStat);
		} catch {
			replied = 'failed';
		}
	}
	return json({ success: true, eventId: result.eventId, uid: result.uid, replied });
};
