import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { changePassword } from '$lib/server/auth/user';
import { revokeOtherSessions } from '$lib/server/auth/app-session';
import { hasSecondFactor } from '$lib/server/auth/mfa';
import { isLockedOut, recordFailure, recordSuccess } from '$lib/server/auth/rate-limit';
import { stepUpRequired } from '$lib/server/auth/step-up';

export const POST: RequestHandler = async ({ locals, request, getClientAddress }) => {
	if (!locals.user || !locals.sessionId) error(401, 'Not signed in');
	// The current password below is the re-check when it's all there is;
	// with a second factor set up, that has to be shown too.
	if (hasSecondFactor(locals.user.id)) {
		const refused = stepUpRequired(locals);
		if (refused) return refused;
	}

	const { current, next } = (await request.json().catch(() => ({}))) as {
		current?: string;
		next?: string;
	};
	if (!current || !next) error(400, 'Current and new password are required');
	if (next.length < 8) error(400, 'New password must be at least 8 characters');

	// Wrong current passwords count against this login exactly as wrong
	// step-up answers do, so a stolen session can't sit here and guess the
	// master password.
	const scope = `step-up:${locals.user.id}`;
	const ip = getClientAddress();
	if (isLockedOut(scope, ip)) error(429, 'Too many attempts. Try again in a few minutes.');

	if (!(await changePassword(locals.user.id, current, next))) {
		recordFailure(scope, ip);
		error(403, 'Current password is incorrect');
	}
	recordSuccess(scope, ip);

	// Standard hygiene: a password change signs out every other device.
	revokeOtherSessions(locals.user.id, locals.sessionId);
	return json({ success: true });
};
