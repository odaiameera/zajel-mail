import { fail, redirect, type Cookies } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { verifyUserPassword } from '$lib/server/auth/user';
import { createAppSession } from '$lib/server/auth/app-session';
import {
	createMfaChallenge,
	deleteMfaChallenge,
	hasSecondFactor,
	pendingMfaUser,
	takeMfaAttempt,
	totpEnabled,
	verifySecondFactorCode
} from '$lib/server/auth/mfa';
import { listPasskeys } from '$lib/server/auth/passkeys';
import {
	isIpLockedOut,
	isLockedOut,
	recordFailure,
	recordIpFailure,
	recordSuccess
} from '$lib/server/auth/rate-limit';
import { MFA_COOKIE, MFA_COOKIE_OPTIONS, SESSION_COOKIE_OPTIONS } from '$lib/server/auth/sign-in';

/** The longest an email address can be (RFC 5321). */
const MAX_EMAIL_LENGTH = 254;

/** What the second step can offer this user. */
function secondStep(userId: string) {
	return { secondStep: true as const, totp: totpEnabled(userId), passkey: listPasskeys(userId).length > 0 };
}

function startSession(cookies: Cookies, request: Request, ip: string, userId: string, verified: boolean): never {
	const sessionId = createAppSession(userId, request.headers.get('user-agent') ?? undefined, ip, verified);
	cookies.set('session', sessionId, SESSION_COOKIE_OPTIONS);
	redirect(303, '/inbox');
}

export const load: PageServerLoad = async ({ locals, cookies }) => {
	if (locals.user) {
		redirect(303, '/inbox');
	}
	// A second step in progress survives a reload.
	const pending = cookies.get(MFA_COOKIE);
	const userId = pending ? pendingMfaUser(pending) : null;
	return { pending: userId ? secondStep(userId) : null };
};

export const actions: Actions = {
	default: async ({ request, cookies, getClientAddress }) => {
		const data = await request.formData();
		const email = data.get('email')?.toString() ?? '';
		const password = data.get('password')?.toString() ?? '';

		if (!email || !password) {
			return fail(400, { error: 'Email and password are required', email });
		}
		// Anyone can post this form; no real address is longer, so don't spend
		// a password check or a rate-limit row on it, or echo it back.
		if (email.length > MAX_EMAIL_LENGTH) {
			return fail(400, { error: 'Invalid email or password', email: '' });
		}

		const ip = getClientAddress();
		if (isIpLockedOut(ip) || isLockedOut(email, ip)) {
			return fail(429, { error: 'Too many attempts. Try again in a few minutes.', email });
		}

		const user = await verifyUserPassword(email, password);
		if (!user) {
			recordFailure(email, ip);
			recordIpFailure(ip);
			return fail(401, { error: 'Invalid email or password', email });
		}

		recordSuccess(email, ip);
		// With a second factor set up, the password alone isn't enough.
		if (hasSecondFactor(user.id)) {
			cookies.set(MFA_COOKIE, createMfaChallenge(user.id), MFA_COOKIE_OPTIONS);
			return { email, ...secondStep(user.id) };
		}
		startSession(cookies, request, ip, user.id, false);
	},

	code: async ({ request, cookies, getClientAddress }) => {
		const data = await request.formData();
		const code = data.get('code')?.toString() ?? '';
		const ip = getClientAddress();

		const pending = cookies.get(MFA_COOKIE);
		const userId = pending ? takeMfaAttempt(pending) : null;
		if (!pending || !userId) {
			cookies.delete(MFA_COOKIE, { path: '/' });
			return fail(401, { error: 'Sign in again', email: '' });
		}
		// Wrong codes count per address and per login: someone who has the
		// password can't keep guessing by moving between addresses.
		const codeScope = `second-step:${userId}`;
		if (isIpLockedOut(ip) || isLockedOut(codeScope, '')) {
			return fail(429, { error: 'Too many attempts. Try again in a few minutes.', email: '', ...secondStep(userId) });
		}

		if (!verifySecondFactorCode(userId, code)) {
			recordIpFailure(ip);
			recordFailure(codeScope, '');
			return fail(401, { error: 'That code didn’t work', email: '', ...secondStep(userId) });
		}

		deleteMfaChallenge(pending);
		cookies.delete(MFA_COOKIE, { path: '/' });
		startSession(cookies, request, ip, userId, true);
	},

	cancel: async ({ cookies }) => {
		const pending = cookies.get(MFA_COOKIE);
		if (pending) deleteMfaChallenge(pending);
		cookies.delete(MFA_COOKIE, { path: '/' });
		return { email: '' };
	}
};
