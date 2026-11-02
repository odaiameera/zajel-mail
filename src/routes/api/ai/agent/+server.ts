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
import { trackTurn } from '$lib/server/agent/turns';
import { aiProvider, MailAssistantError, type AIChatMessage } from '$lib/server/ai/mail-assistant';
import { taskAdapterProviders } from '$lib/server/ai/task-adapter';
import { renderAgentMarkdown } from '$lib/server/ai/markdown';
import {
	appendMessage,
	conversationExists,
	createConversation,
	listMessages
} from '$lib/server/db/queries/ai-conversations';
import { errorFields, logEvent } from '$lib/server/log';
import { heldOpen } from '$lib/server/held-open';

const ACTIONS = new Set<MailAgentAction>([
	'chat',
	'summarize_today',
	'calendar_tomorrow',
	'summarize_current',
	'propose_task'
]);
const DAY_MS = 86_400_000;

/** What the panel is told when a turn fails, with the cause in the event log. */
function failure(error: unknown, provider: string, started: number): Record<string, unknown> {
	if (error instanceof MailAssistantError) {
		logEvent('warn', 'agent', 'request_failed', { provider, status: error.status, error: error.message, ms: Date.now() - started });
		return { error: error.message };
	}
	console.error('[ai-agent] request failed', error);
	logEvent('error', 'agent', 'request_failed', { provider, ...errorFields(error), ms: Date.now() - started });
	return { error: 'The mail agent could not load your account context' };
}

/**
 * The held-open reply, with the session id and how many messages it held
 * before this turn in headers. They arrive before the turn ends, so a panel
 * whose body is cut off still knows which session to ask for the reply and
 * its cards, and can tell this turn's reply from an earlier one.
 */
function reply(conversationId: string, storedBefore: number, work: Promise<Record<string, unknown>>): Response {
	const response = heldOpen(trackTurn(conversationId, work));
	response.headers.set('X-Conversation-Id', conversationId);
	response.headers.set('X-Turn-Base', String(storedBefore));
	return response;
}

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
	const stored = listMessages(conversationId, userEmail);
	const conversation: AIChatMessage[] = stored
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

	const started = Date.now();
	const auth = locals.auth;

	// With Claude: the tool-using agent, which can act on the mailbox.
	if (claudeConfigured() && locals.user && locals.activeAccountId) {
		const userId = locals.user.id;
		const accountRowId = locals.activeAccountId;
		return reply(
			conversationId,
			stored.length,
			(async () => {
				try {
					const result = await runAgentTurn({
						auth,
						userId,
						userEmail,
						accountRowId,
						conversationId,
						source: 'chat',
						message,
						history: conversation,
						timeZone,
						today: localDate(todayStartMs, timeZone),
						currentEmailId
					});
					// A refusal stays out of the transcript: replayed as history in
					// every later turn, it would only invite another.
					if (result.outcome !== 'refused') {
						appendMessage(conversationId, userEmail, 'user', message);
						appendMessage(conversationId, userEmail, 'assistant', result.message);
					}
					return {
						message: result.message,
						html: renderAgentMarkdown(result.message),
						done: result.done,
						pending: result.pending.map(pendingView),
						conversationId,
						taskProviders: taskAdapterProviders()
					};
				} catch (error) {
					return failure(error, 'anthropic', started);
				}
			})()
		);
	}

	return reply(
		conversationId,
		stored.length,
		(async () => {
			try {
				const result = await runMailAgent(auth, userEmail, {
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

				return {
					...result,
					html: renderAgentMarkdown(result.message),
					conversationId,
					taskProviders: taskAdapterProviders()
				};
			} catch (error) {
				return failure(error, aiProvider() ?? 'none', started);
			}
		})()
	);
};
