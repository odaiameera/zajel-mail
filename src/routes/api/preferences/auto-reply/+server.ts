import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { writePreferences } from '$lib/server/preferences';

/**
 * Persist the auto-reply settings.
 *
 * The body used to be percent-encoded into a cookie, which meant a long
 * message could quietly exceed the ~4KB cookie cap and be dropped. In
 * SQLite it is stored whole.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) error(401, 'Not signed in');
	const body = (await request.json()) as {
		enabled?: boolean;
		subject?: string;
		body?: string;
	};

	const patch: Record<string, string> = {};
	if (body.enabled !== undefined) patch.auto_reply_enabled = body.enabled ? 'on' : 'off';
	if (body.subject !== undefined) patch.auto_reply_subject = body.subject;
	if (body.body !== undefined) patch.auto_reply_body = body.body;
	writePreferences(locals.user.id, patch);
	return json({ success: true });
};
