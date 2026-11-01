import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import { markSessionVerified } from '$lib/server/auth/app-session';
import { hasSecondFactor, totpEnabled, verifySecondFactorCode } from '$lib/server/auth/mfa';
import { listPasskeys } from '$lib/server/auth/passkeys';
import { isLockedOut, recordFailure } from '$lib/server/auth/rate-limit';
import { verifyPasswordForUser } from '$lib/server/auth/user';
import { verifyAuthentication } from '$lib/server/auth/webauthn';

/**
 * Re-check that it's you before a risky change: a passkey, an authenticator
 * or recovery code, or (only while no second factor is set up) the
 * password. Success marks this session as freshly verified.
 */

/** Which ways of re-checking this login has. */
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) error(401, 'Not signed in');
	const userId = locals.user.id;
	return json({
		passkey: listPasskeys(userId).length > 0,
		totp: totpEnabled(userId),
		password: !hasSecondFactor(userId)
	});
};

export const POST: RequestHandler = async ({ locals, request, url, getClientAddress }) => {
	if (!locals.user || !locals.sessionId) error(401, 'Not signed in');
	const userId = locals.user.id;
	const body = (await request.json().catch(() => null)) as {
		code?: unknown;
		password?: unknown;
		passkey?: AuthenticationResponseJSON;
	} | null;

	// Wrong codes and passwords count against this login, so a stolen session
	// can't sit and guess.
	const scope = `step-up:${userId}`;
	const ip = getClientAddress();
	if (isLockedOut(scope, ip)) error(429, 'Too many attempts. Try again in a few minutes.');

	let ok = false;
	if (body?.passkey) {
		const passkey = await verifyAuthentication(url, body.passkey).catch(() => undefined);
		ok = passkey?.user_id === userId;
	} else if (typeof body?.code === 'string') {
		ok = verifySecondFactorCode(userId, body.code) !== null;
	} else if (typeof body?.password === 'string') {
		// A password re-check only stands in while there is nothing stronger.
		ok = !hasSecondFactor(userId) && (await verifyPasswordForUser(userId, body.password));
	}

	if (!ok) {
		recordFailure(scope, ip);
		error(401, 'That didn’t work');
	}
	markSessionVerified(locals.sessionId);
	return json({ success: true });
};
