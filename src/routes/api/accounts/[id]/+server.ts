import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	getAccount,
	removeAccount,
	setAccountColor,
	setAccountDisplayName
} from '$lib/server/auth/accounts';
import { stepUpRequired } from '$lib/server/auth/step-up';

/** Update how a linked account presents itself: its name and its colour. */
export const PATCH: RequestHandler = async ({ request, params, locals }) => {
	if (!locals.user) error(401, 'Not signed in');
	const account = getAccount(params.id);
	if (!account || account.user_id !== locals.user.id) error(404, 'Unknown account');

	const { color, displayName } = (await request.json()) as {
		color?: string;
		displayName?: string;
	};

	if (typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color)) {
		setAccountColor(locals.user.id, params.id, color);
	}
	// An empty string is meaningful here — it clears the override and falls
	// back to the address — so this checks the type, not truthiness.
	if (typeof displayName === 'string') {
		if (displayName.length > 120) error(400, 'Name is too long');
		setAccountDisplayName(locals.user.id, params.id, displayName);
	}

	return json({ success: true });
};

/**
 * Unlink a mail account. Its SQLite data (labels, rules, reminders…) is
 * left in place keyed by email, so re-linking later restores everything.
 */
export const DELETE: RequestHandler = async ({ params, locals, cookies }) => {
	if (!locals.user) error(401, 'Not signed in');
	const refused = stepUpRequired(locals);
	if (refused) return refused;
	const account = getAccount(params.id);
	if (!account || account.user_id !== locals.user.id) error(404, 'Unknown account');

	removeAccount(locals.user.id, params.id);
	if (cookies.get('active_account') === params.id) {
		cookies.delete('active_account', { path: '/' });
	}
	return json({ success: true });
};
