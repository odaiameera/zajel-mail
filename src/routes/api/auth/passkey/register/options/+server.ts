import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { registrationOptions } from '$lib/server/auth/webauthn';
import { stepUpRequired } from '$lib/server/auth/step-up';

export const POST: RequestHandler = async ({ locals, url }) => {
	if (!locals.user) error(401, 'Not signed in');
	// A passkey signs in on its own, so adding one needs a fresh re-check.
	const refused = stepUpRequired(locals);
	if (refused) return refused;
	return json(await registrationOptions(url, locals.user));
};
