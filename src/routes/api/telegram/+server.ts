import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { stepUpRequired } from '$lib/server/auth/step-up';
import { botUsername, telegramConfigured, TelegramError } from '$lib/server/telegram/bot';
import { sendTestAlert } from '$lib/server/telegram/notifier';
import { createLinkCode, getLink, setLinkFlags, unlink } from '$lib/server/telegram/store';
import { errorFields, logEvent } from '$lib/server/log';
import { listAccounts } from '$lib/server/auth/accounts';
import { jevBlock } from '$lib/server/jev/reach';

/** The agent's Telegram bot: link a chat, unlink it, switch alerts on or off, send a test. */

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) error(401, 'Not signed in');
	const link = getLink(locals.user.id);
	return json({
		configured: telegramConfigured(),
		linked: !!link,
		username: link?.username ?? null,
		urgent: link?.urgent ?? false,
		paused: link?.paused ?? false,
		// Urgency is Jev's call, so an account Jev doesn't read never alerts,
		// whatever the Urgent mail switch says.
		accounts: listAccounts(locals.user.id).map((account) => ({ email: account.email, blocked: jevBlock(account) }))
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
		// Only ever reaches the chat already linked, so no re-check.
		case 'test': {
			let result: Awaited<ReturnType<typeof sendTestAlert>>;
			try {
				result = await sendTestAlert(userId);
			} catch (err) {
				logEvent('error', 'telegram', 'test_failed', errorFields(err));
				// 403: the bot was blocked, or the chat is gone.
				if (err instanceof TelegramError && err.status === 403) error(502, 'Telegram won’t deliver to that chat. Open the bot, press Start, or link again');
				error(502, err instanceof TelegramError ? `Telegram refused the message (${err.status})` : 'Telegram didn’t answer');
			}
			if (result === 'not_linked') error(409, 'Link Telegram first');
			if (result === 'limited') error(429, 'The hourly limit of 20 messages is reached');
			logEvent('info', 'telegram', 'test_sent');
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
