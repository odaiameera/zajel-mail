import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getPrefs } from '$lib/server/db/queries/app-prefs';
import { writePreferences } from '$lib/server/preferences';
import { autoReplySettings, autoReplyStatus, nextSince, parseAutoReplyForm } from '$lib/server/auto-reply';

/**
 * Save the out-of-office settings, all at once from the page's Save
 * button. The server stamps `auto_reply_since` when it is switched on or
 * its dates change: mail from before then is never answered. Answers with
 * the new status line.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) error(401, 'Not signed in');
	const parsed = parseAutoReplyForm(((await request.json().catch(() => null)) ?? {}) as Record<string, unknown>);
	if ('error' in parsed) return json({ error: parsed.error }, { status: 400 });

	const { form } = parsed;
	const now = new Date();
	const since = nextSince(autoReplySettings(getPrefs(locals.user.id)), form, now.toISOString());
	writePreferences(locals.user.id, {
		auto_reply_enabled: form.enabled ? 'on' : 'off',
		auto_reply_subject: form.subject,
		auto_reply_body: form.body,
		auto_reply_from: form.from,
		auto_reply_until: form.until,
		auto_reply_tz: form.tz,
		auto_reply_since: since
	});
	return json({ success: true, status: autoReplyStatus({ ...form, since }, now) });
};
