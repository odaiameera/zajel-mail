import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { htmlToPromptText } from '$lib/server/ai/extract-event';
import {
	MailAssistantError,
	runMailAssistant,
	type MailAssistantAction
} from '$lib/server/ai/mail-assistant';
import { runChat } from '$lib/server/ai/chat';

const ACTIONS: MailAssistantAction[] = ['summarize', 'answer', 'draft'];

export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.auth) return json({ error: 'Unauthorized' }, { status: 401 });

	const body = (await request.json().catch(() => null)) as {
		action?: string;
		subject?: string;
		from?: string;
		receivedAt?: string;
		html?: string;
		question?: string;
	} | null;
	if (!body || !body.action || !ACTIONS.includes(body.action as MailAssistantAction)) {
		return json({ error: 'A valid action is required' }, { status: 400 });
	}
	if (typeof body.html !== 'string') {
		return json({ error: 'Email content is required' }, { status: 400 });
	}

	try {
		const result = await runMailAssistant({
			action: body.action as MailAssistantAction,
			subject: typeof body.subject === 'string' ? body.subject.slice(0, 500) : '',
			from: typeof body.from === 'string' ? body.from.slice(0, 300) : '',
			receivedAt: typeof body.receivedAt === 'string' ? body.receivedAt.slice(0, 100) : '',
			bodyText: htmlToPromptText(body.html, 10_000),
			question: typeof body.question === 'string' ? body.question.slice(0, 500) : undefined
		}, runChat);
		return json({ result });
	} catch (err) {
		if (err instanceof MailAssistantError) {
			return json({ error: err.message }, { status: err.status });
		}
		return json({ error: 'The assistant failed' }, { status: 502 });
	}
};
