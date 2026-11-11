import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	getAccount,
	removeAccount,
	setAccountColor,
	setAccountDisplayName,
	toPublic,
	unlinkLosses
} from '$lib/server/auth/accounts';
import { stepUpRequired } from '$lib/server/auth/step-up';
import { forgetVectors } from '$lib/server/search/vectors';

/** One account, with what unlinking it would take along (for the confirm). */
export const GET: RequestHandler = ({ params, locals }) => {
	if (!locals.user) error(401, 'Not signed in');
	const account = getAccount(params.id);
	if (!account || account.user_id !== locals.user.id) error(404, 'Unknown account');
	return json({ account: toPublic(account), unlink: unlinkLosses(params.id) });
};

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
 * Unlink a mail account. Data keyed by its address (labels, folders,
 * signatures, reminders) stays and re-attaches on re-link; data keyed by
 * this row, rules included, cascades away (see {@link unlinkLosses}), and
 * the client shows the counts before asking.
 */
export const DELETE: RequestHandler = async ({ params, locals, cookies }) => {
	if (!locals.user) error(401, 'Not signed in');
	const refused = stepUpRequired(locals);
	if (refused) return refused;
	const account = getAccount(params.id);
	if (!account || account.user_id !== locals.user.id) error(404, 'Unknown account');

	removeAccount(locals.user.id, params.id);
	// The search rows cascaded with the account; drop the in-memory copy too.
	forgetVectors(params.id);
	if (cookies.get('active_account') === params.id) {
		cookies.delete('active_account', { path: '/' });
	}
	return json({ success: true });
};
