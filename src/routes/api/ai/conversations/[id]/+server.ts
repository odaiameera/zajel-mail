import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { userEmailFromAuth } from '$lib/server/user';
import {
	conversationExists,
	deleteConversation,
	listMessages
} from '$lib/server/db/queries/ai-conversations';
import { renderAgentMarkdown } from '$lib/server/ai/markdown';
import { pendingView } from '$lib/server/agent/actions';
import { listPendingActions } from '$lib/server/agent/store';
import { turnRunning } from '$lib/server/agent/turns';

/**
 * Replay one session.
 *
 * Assistant turns are stored as markdown and rendered here rather than at
 * write time, so a change to the sanitising allowlist covers history too.
 * User turns stay plain text — they are echoed back into the user's own
 * bubble and never need markup.
 *
 * Cards still waiting for a click come with it, and whether a turn is still
 * running, so a reply the browser never received (or a reload) loses nothing.
 */
export const GET: RequestHandler = async ({ locals, params }) => {
	if (!locals.auth) return json({ error: 'Unauthorized' }, { status: 401 });

	const userEmail = userEmailFromAuth(locals.auth);
	// A conversation belonging to someone else is indistinguishable from one
	// that does not exist.
	if (!conversationExists(params.id, userEmail)) {
		return json({ error: 'Conversation not found' }, { status: 404 });
	}

	return json({
		id: params.id,
		messages: listMessages(params.id, userEmail).map((message) => ({
			id: String(message.id),
			role: message.role,
			content: message.content,
			html: message.role === 'assistant' ? renderAgentMarkdown(message.content) : '',
			createdAt: message.createdAt
		})),
		pending: locals.user ? listPendingActions(locals.user.id, params.id).map(pendingView) : [],
		running: turnRunning(params.id)
	});
};

export const DELETE: RequestHandler = async ({ locals, params }) => {
	if (!locals.auth) return json({ error: 'Unauthorized' }, { status: 401 });

	if (!deleteConversation(params.id, userEmailFromAuth(locals.auth))) {
		return json({ error: 'Conversation not found' }, { status: 404 });
	}
	return json({ ok: true });
};
