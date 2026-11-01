import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { stepUpRequired } from '$lib/server/auth/step-up';
import { botUsername, telegramConfigured } from '$lib/server/telegram/bot';
import { createLinkCode, getLink, setLinkFlags, unlink } from '$lib/server/telegram/store';

/** The agent's Telegram bot: link a chat, unlink it, switch alerts on or off. */

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) error(401, 'Not signed in');
	const link = getLink(locals.user.id);
	return json({
		configured: telegramConfigured(),
		linked: !!link,
		username: link?.username ?? null,
		urgent: link?.urgent ?? false,
		paused: link?.paused ?? false
	});
};

export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.user) error(401, 'Not signed in');
	if (!telegramConfigured()) error(501, 'Telegram isn’t set up on this server');
	const userId = locals.user.id;
	const body = (await request.json().catch(() => null)) as { action?: unknown; urgent?: unknown; paused?: unknown } | null;

	switch (body?.action) {
		// A linked chat gets your mail's senders and subjects, so linking and
		// unlinking both need a fresh re-check.
		case 'link': {
			const refused = stepUpRequired(locals);
			if (refused) return refused;
			const name = await botUsername().catch(() => null);
			if (!name) error(502, 'Telegram didn’t answer');
			return json({ url: `https://t.me/${name}?start=${createLinkCode(userId)}` });
		}
		case 'unlink': {
			const refused = stepUpRequired(locals);
			if (refused) return refused;
			unlink(userId);
			return json({ success: true });
		}
		case 'set':
			setLinkFlags(userId, {
				urgent: typeof body.urgent === 'boolean' ? body.urgent : undefined,
				paused: typeof body.paused === 'boolean' ? body.paused : undefined
			});
			return json({ success: true });
		default:
			error(400, 'Unknown action');
	}
};
