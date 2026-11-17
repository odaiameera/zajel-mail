import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { createClient } from '$lib/jmap/auth';
import { getEmailDetail } from '$lib/jmap/email';
import { getThread, type OpenThread } from '$lib/jmap/threads';
import { threadScope } from '$lib/server/conversations';
import { conversationsOn } from '$lib/server/db/queries/app-prefs';
import { userEmailFromAuth } from '$lib/server/user';
import { clearMarker } from '$lib/server/db/queries/reminders';

export const load: PageServerLoad = async ({ locals, params, parent }) => {
	if (!locals.auth) {
		redirect(303, '/login');
	}

	const client = createClient(locals.auth);
	const { accountId } = locals.auth;

	// With Conversation view on, a message opens with the rest of its
	// thread. A conversation of one is just the message, in the usual view.
	let thread: OpenThread | null = null;
	if (conversationsOn(locals.user?.id ?? '')) {
		const { mailboxes } = await parent();
		const open = await getThread(client, accountId, params.id, threadScope(mailboxes, null));
		if (open.messages.length > 1) thread = open;
	}
	const email = thread?.details[params.id] ?? (await getEmailDetail(client, accountId, params.id));

	// Opening a reminded email clears its clock badge. Cheap SQL; running
	// on every open is fine (idempotent DELETE).
	clearMarker(userEmailFromAuth(locals.auth), params.id);

	return { email, thread };
};
