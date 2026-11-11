import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { listAccounts } from '$lib/server/auth/accounts';
import { autoReplySettings, autoReplyStatus } from '$lib/server/auto-reply';
import { recentAutoReplies } from '$lib/server/db/queries/auto-reply-log';
import { readPreferences } from '$lib/server/preferences';

/** How many of the latest replies the page lists. */
const RECENT = 8;

export const load: PageServerLoad = ({ locals, cookies }) => {
	if (!locals.user) error(401, 'Not signed in');
	const settings = autoReplySettings(readPreferences(locals.user.id, cookies));
	const accounts = listAccounts(locals.user.id);
	const emailOf = new Map(accounts.map((a) => [a.id, a.email]));
	return {
		autoReply: {
			// Switched on before replies were sent by the app (no `since`):
			// shown as off, so it is only ever on once saved here.
			enabled: settings.enabled && !!settings.since,
			subject: settings.subject,
			body: settings.body,
			from: settings.from,
			until: settings.until
		},
		status: autoReplyStatus(settings, new Date()),
		sent: recentAutoReplies([...emailOf.keys()], RECENT).map((r) => ({
			to: r.sender,
			at: r.sent_at,
			account: emailOf.get(r.account_id) ?? ''
		})),
		multipleAccounts: accounts.length > 1
	};
};
