import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import type { RegistrationResponseJSON } from '@simplewebauthn/server';
import { verifyRegistration } from '$lib/server/auth/webauthn';
import { stepUpRequired } from '$lib/server/auth/step-up';

export const POST: RequestHandler = async ({ locals, url, request }) => {
	if (!locals.user) error(401, 'Not signed in');
	const refused = stepUpRequired(locals);
	if (refused) return refused;

	const body = (await request.json()) as {
		response?: RegistrationResponseJSON;
		name?: string;
	};
	if (!body.response) error(400, 'Missing registration response');
	const name = body.name?.trim() || 'Passkey';

	let result;
	try {
		result = await verifyRegistration(url, locals.user, body.response, name);
	} catch {
		error(400, 'Registration could not be verified');
	}
	if (!result) error(400, 'Registration could not be verified');

	return json({ success: true, id: result.id });
};
