import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { userEmailFromAuth } from '$lib/server/user';
import {
	localDate,
	runMailAgent,
	type MailAgentAction
} from '$lib/server/ai/mail-agent';
import { claudeConfigured } from '$lib/server/ai/claude';
import { runAgentTurn } from '$lib/server/agent/runtime';
import { pendingView } from '$lib/server/agent/actions';
import { MailAssistantError, type AIChatMessage } from '$lib/server/ai/mail-assistant';
import { taskAdapterProviders } from '$lib/server/ai/task-adapter';
import { renderAgentMarkdown } from '$lib/server/ai/markdown';
import {
	appendMessage,
	conversationExists,
	createConversation,
	listMessages
} from '$lib/server/db/queries/ai-conversations';

const ACTIONS = new Set<MailAgentAction>([
	'chat',
	'summarize_today',
	'calendar_tomorrow',
	'summarize_current',
	'propose_task'
]);
const DAY_MS = 86_400_000;

function safeTimeZone(value: unknown): string {
	if (typeof value !== 'string' || value.length > 100) return 'UTC';
	try {
		new Intl.DateTimeFormat('en', { timeZone: value }).format();
		return value;
	} catch {
		return 'UTC';
	}
}

function range(startValue: unknown, endValue: unknown, fallbackOffset: number): [number, number] {
	const start = Date.parse(typeof startValue === 'string' ? startValue : '');
	const end = Date.parse(typeof endValue === 'string' ? endValue : '');
	if (Number.isFinite(start) && Number.isFinite(end) && end > start && end - start <= DAY_MS * 2) {
		return [start, end];
	}
	const fallbackStart = new Date();
	fallbackStart.setUTCHours(0, 0, 0, 0);
	fallbackStart.setUTCDate(fallbackStart.getUTCDate() + fallbackOffset);
	return [fallbackStart.getTime(), fallbackStart.getTime() + DAY_MS];
}

export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.auth) return json({ error: 'Unauthorized' }, { status: 401 });

	const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
	const action = body?.action;
	const message = typeof body?.message === 'string' ? body.message.trim().slice(0, 1500) : '';
	if (typeof action !== 'string' || !ACTIONS.has(action as MailAgentAction) || !message) {
		return json({ error: 'A valid action and message are required' }, { status: 400 });
	}

	const userEmail = userEmailFromAuth(locals.auth);

	// Resolve the session before doing any work. An id the caller does not
	// own is treated as absent and a fresh session is started, so a guessed
	// id can neither read another account's history nor append to it.
	const requestedId = typeof body?.conversationId === 'string' ? body.conversationId : '';
	const conversationId =
		requestedId && conversationExists(requestedId, userEmail)
			? requestedId
			: createConversation(userEmail);

	// History comes from storage, not from the request. The client used to
	// send the transcript back with every turn, which meant it could invent
	// assistant turns the agent had never produced.
	const conversation: AIChatMessage[] = listMessages(conversationId, userEmail)
		.slice(-12)
		.map((stored) => ({ role: stored.role, content: stored.content.slice(0, 1500) }));
	const [todayStartMs, todayEndMs] = range(body?.todayStart, body?.todayEnd, 0);
	const [tomorrowStartMs, tomorrowEndMs] = range(
		body?.tomorrowStart,
		body?.tomorrowEnd,
		1
	);

	const timeZone = safeTimeZone(body?.timeZone);
	const currentEmailId =
		typeof body?.currentEmailId === 'string' && body.currentEmailId.length <= 300 ? body.currentEmailId : null;

	// With Claude: the tool-using agent, which can act on the mailbox.
	if (claudeConfigured() && locals.user && locals.activeAccountId) {
		try {
			const result = await runAgentTurn({
				auth: locals.auth,
				userId: locals.user.id,
				userEmail,
				accountRowId: locals.activeAccountId,
				conversationId,
				source: 'chat',
				message,
				history: conversation,
				timeZone,
				today: localDate(todayStartMs, timeZone),
				currentEmailId
			});
			appendMessage(conversationId, userEmail, 'user', message);
			appendMessage(conversationId, userEmail, 'assistant', result.message);
			return json({
				message: result.message,
				html: renderAgentMarkdown(result.message),
				done: result.done,
				pending: result.pending.map(pendingView),
				conversationId,
				taskProviders: taskAdapterProviders()
			});
		} catch (error) {
			if (error instanceof MailAssistantError) {
				return json({ error: error.message }, { status: error.status });
			}
			console.error('[ai-agent] request failed', error);
			return json({ error: 'The mail agent could not load your account context' }, { status: 502 });
		}
	}

	try {
		const result = await runMailAgent(locals.auth, userEmail, {
			action: action as MailAgentAction,
			message,
			conversation,
			currentEmailId,
			timeZone,
			todayStartMs,
			todayEndMs,
			tomorrowStartMs,
			tomorrowEndMs
		});
		// Persisted only once the model has answered: a failed turn should not
		// leave a question in the transcript that was never addressed.
		appendMessage(conversationId, userEmail, 'user', message);
		appendMessage(conversationId, userEmail, 'assistant', result.message);

		return json({
			...result,
			html: renderAgentMarkdown(result.message),
			conversationId,
			taskProviders: taskAdapterProviders()
		});
	} catch (error) {
		if (error instanceof MailAssistantError) {
			return json({ error: error.message }, { status: error.status });
		}
		console.error('[ai-agent] request failed', error);
		return json({ error: 'The mail agent could not load your account context' }, { status: 502 });
	}
};
