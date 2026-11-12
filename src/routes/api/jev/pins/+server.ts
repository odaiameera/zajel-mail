import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listAccounts } from '$lib/server/auth/accounts';
import { deletePin, normalizePinSender, setPin } from '$lib/server/db/queries/jev-learning';
import { refreshPipeline } from '$lib/server/mail-pipeline';
import { isInboxCategory } from '$lib/types/categories';

/**
 * Sender pins: "always put mail from X in this tab". `accountId` is one of
 * this login's linked accounts, defaulting to the one in use; `sender` an
 * address or `@domain`.
 *
 * An account's first pin switches on the Inbox's hold on new mail (with
 * tabs on and Jev off), and its last one switches it off. The push stream
 * that keeps that hold short follows at once, not on its next minute.
 */

async function readBody(request: Request, userId: string) {
	const body = (await request.json().catch(() => ({}))) as {
		accountId?: unknown;
		sender?: unknown;
		category?: unknown;
	};
	const accountId = typeof body.accountId === 'string' ? body.accountId : null;
	const owned = listAccounts(userId).map((a) => a.id);
	const sender = typeof body.sender === 'string' ? normalizePinSender(body.sender) : null;
	return { body, accountId, owned, sender };
}

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) error(401, 'Not signed in');
	const { body, accountId, owned, sender } = await readBody(request, locals.user.id);
	const account = accountId ?? locals.activeAccountId ?? '';
	if (!owned.includes(account)) return json({ error: 'Unknown account' }, { status: 404 });
	if (!sender) return json({ error: 'Give an email address or an @domain' }, { status: 400 });
	if (!isInboxCategory(body.category)) return json({ error: 'Pick a tab' }, { status: 400 });

	setPin(account, sender, body.category);
	refreshPipeline();
	return json({ success: true, pin: { sender, category: body.category } });
};

export const DELETE: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) error(401, 'Not signed in');
	const { accountId, owned, sender } = await readBody(request, locals.user.id);
	const account = accountId ?? locals.activeAccountId ?? '';
	if (!owned.includes(account)) return json({ error: 'Unknown account' }, { status: 404 });
	if (!sender) return json({ error: 'Give an email address or an @domain' }, { status: 400 });

	deletePin(account, sender);
	refreshPipeline();
	return json({ success: true });
};
