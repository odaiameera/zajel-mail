import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import { verifyAuthentication } from '$lib/server/auth/webauthn';
import { createAppSession } from '$lib/server/auth/app-session';
import { deleteMfaChallenge } from '$lib/server/auth/mfa';
import { MFA_COOKIE, SESSION_COOKIE_OPTIONS } from '$lib/server/auth/sign-in';

export const POST: RequestHandler = async ({ url, request, cookies, getClientAddress }) => {
	const response = (await request.json()) as AuthenticationResponseJSON;

	let passkey;
	try {
		passkey = await verifyAuthentication(url, response);
	} catch {
		error(401, 'Passkey sign-in failed');
	}
	if (!passkey) error(401, 'Passkey sign-in failed');

	// A passkey that checked it's you is a full sign-in on its own; it also
	// completes a second step left pending after the password.
	const pending = cookies.get(MFA_COOKIE);
	if (pending) {
		deleteMfaChallenge(pending);
		cookies.delete(MFA_COOKIE, { path: '/' });
	}

	const sessionId = createAppSession(
		passkey.user_id,
		request.headers.get('user-agent') ?? undefined,
		getClientAddress(),
		true
	);
	cookies.set('session', sessionId, SESSION_COOKIE_OPTIONS);
	return json({ success: true });
};
