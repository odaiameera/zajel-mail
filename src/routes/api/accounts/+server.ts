import { error, json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import type { RequestHandler } from './$types';
import { JMAPAuthError } from '$lib/jmap/client';
import {
	describeLinkError,
	linkAccount,
	listAccounts,
	normalizeServerUrl,
	toPublic
} from '$lib/server/auth/accounts';
import { DEFAULT_LABEL_COLOR } from '$lib/constants/colors';
import { stepUpRequired } from '$lib/server/auth/step-up';

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) error(401, 'Not signed in');
	return json({ accounts: listAccounts(locals.user.id).map(toPublic) });
};

/** Link a new mail account: verify against the mail server, store encrypted. */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) error(401, 'Not signed in');
	// Linking is a risky change like unlinking: it can point an existing
	// account's credentials at another server. Same re-check.
	const refused = stepUpRequired(locals);
	if (refused) return refused;

	const body = (await request.json().catch(() => ({}))) as {
		email?: string;
		password?: string;
		serverUrl?: string;
		color?: string;
		displayName?: string;
	};
	const email = body.email?.trim() ?? '';
	const password = body.password ?? '';
	if (!email || !password) error(400, 'Email and password are required');

	// Default server: explicit > env > wherever the existing accounts live.
	const serverUrl =
		normalizeServerUrl(body.serverUrl ?? '') ||
		normalizeServerUrl(env.JMAP_BASE_URL ?? '') ||
		listAccounts(locals.user.id)[0]?.server_url;
	if (!serverUrl) error(400, 'No mail server configured');

	try {
		const account = await linkAccount({
			userId: locals.user.id,
			email,
			password,
			serverUrl,
			color: body.color || DEFAULT_LABEL_COLOR.hex,
			displayName: body.displayName?.trim() || undefined
		});
		return json({ account });
	} catch (err) {
		if (err instanceof JMAPAuthError) {
			error(401, 'The mail server rejected those credentials');
		}
		console.error('[accounts] linking mail account failed:', err);
		error(502, describeLinkError(err, serverUrl));
	}
};
