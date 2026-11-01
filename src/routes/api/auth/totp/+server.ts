import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { markSessionVerified } from '$lib/server/auth/app-session';
import {
	beginTotp,
	confirmTotp,
	disableTotp,
	recoveryCodesLeft,
	regenerateRecoveryCodes,
	totpEnabled
} from '$lib/server/auth/mfa';
import { stepUpRequired } from '$lib/server/auth/step-up';
import { otpauthQrSvg, otpauthUri } from '$lib/server/auth/totp';

/** Authenticator-app second factor: status, set up, turn off, new recovery codes. */

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) error(401, 'Not signed in');
	return json({
		enabled: totpEnabled(locals.user.id),
		recoveryCodesLeft: recoveryCodesLeft(locals.user.id)
	});
};

export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.user || !locals.sessionId) error(401, 'Not signed in');
	// Every change here is a change to how you sign in.
	const refused = stepUpRequired(locals);
	if (refused) return refused;

	const userId = locals.user.id;
	const body = (await request.json().catch(() => null)) as { action?: unknown; code?: unknown } | null;

	switch (body?.action) {
		case 'begin': {
			const secret = beginTotp(userId);
			if (!secret) error(409, 'An authenticator app is already set up');
			const uri = otpauthUri(secret, locals.user.email);
			return json({ secret, uri, qr: otpauthQrSvg(uri) });
		}
		case 'confirm': {
			if (typeof body.code !== 'string') error(400, 'Enter the code from the app');
			const recoveryCodes = confirmTotp(userId, body.code);
			if (!recoveryCodes) error(400, 'That code didn’t match');
			markSessionVerified(locals.sessionId);
			return json({ recoveryCodes });
		}
		case 'recovery-codes': {
			const recoveryCodes = regenerateRecoveryCodes(userId);
			if (!recoveryCodes) error(409, 'No authenticator app is set up');
			return json({ recoveryCodes });
		}
		case 'disable':
			disableTotp(userId);
			return json({ success: true });
		default:
			error(400, 'Unknown action');
	}
};
