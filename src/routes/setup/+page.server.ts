import { fail, redirect } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import type { Actions, PageServerLoad } from './$types';
import { JMAPAuthError } from '$lib/jmap/client';
import { createAppUser, hasAppUser } from '$lib/server/auth/user';
import { createAppSession } from '$lib/server/auth/app-session';
import { SESSION_COOKIE_OPTIONS } from '$lib/server/auth/sign-in';
import { describeLinkError, linkAccount, normalizeServerUrl } from '$lib/server/auth/accounts';
import { DEFAULT_LABEL_COLOR } from '$lib/constants/colors';

/**
 * First-run flow, two steps on one page:
 *   1. Create the webmail's master login (before any app_user exists).
 *   2. Link the first mail account (logged in, zero accounts linked).
 * Any SQLite data keyed by the linked address (labels, signatures,
 * calendar meta) re-attaches the moment the account is linked.
 */
export const load: PageServerLoad = async ({ locals }) => {
	if (!hasAppUser()) {
		return { step: 'create' as const, defaultServerUrl: env.JMAP_BASE_URL ?? '' };
	}
	if (!locals.user) {
		redirect(303, '/login');
	}
	if ((locals.accounts?.length ?? 0) > 0) {
		redirect(303, '/inbox');
	}
	return { step: 'link' as const, defaultServerUrl: env.JMAP_BASE_URL ?? '' };
};

export const actions: Actions = {
	create: async ({ request, cookies, getClientAddress }) => {
		if (hasAppUser()) {
			return fail(409, { error: 'Setup is already complete', email: '' });
		}
		const data = await request.formData();
		const email = data.get('email')?.toString().trim() ?? '';
		const password = data.get('password')?.toString() ?? '';
		const confirm = data.get('confirm')?.toString() ?? '';

		if (!email || !email.includes('@')) {
			return fail(400, { error: 'Enter a valid email to use as your login', email });
		}
		if (password.length < 8) {
			return fail(400, { error: 'Password must be at least 8 characters', email });
		}
		if (password !== confirm) {
			return fail(400, { error: 'Passwords do not match', email });
		}

		const user = await createAppUser(email, password);
		// Someone else's submission got in first while this password was hashing.
		if (!user) {
			return fail(409, { error: 'Setup is already complete', email: '' });
		}
		// The password was just chosen, which counts as a fresh re-check, so
		// a passkey or an authenticator can be added straight away.
		const sessionId = createAppSession(
			user.id,
			request.headers.get('user-agent') ?? undefined,
			getClientAddress(),
			true
		);
		cookies.set('session', sessionId, SESSION_COOKIE_OPTIONS);
		// Reload /setup — the load function moves us to the link step.
		redirect(303, '/setup');
	},

	link: async ({ request, cookies, locals }) => {
		if (!locals.user) {
			return fail(401, { error: 'Sign in first', email: '' });
		}
		const data = await request.formData();
		const email = data.get('email')?.toString().trim() ?? '';
		const password = data.get('password')?.toString() ?? '';
		const serverUrl =
			normalizeServerUrl(data.get('serverUrl')?.toString() ?? '') ||
			normalizeServerUrl(env.JMAP_BASE_URL ?? '');
		const color = data.get('color')?.toString() || DEFAULT_LABEL_COLOR.hex;

		if (!email || !password) {
			return fail(400, { error: 'Mail address and password are required', email, linkStep: true });
		}
		if (!serverUrl) {
			return fail(400, {
				error: 'No mail server configured. Set JMAP_BASE_URL or enter a server URL.',
				email,
				linkStep: true
			});
		}

		let account;
		try {
			account = await linkAccount({ userId: locals.user.id, email, password, serverUrl, color });
		} catch (err) {
			if (err instanceof JMAPAuthError) {
				return fail(401, {
					error: 'The mail server rejected those credentials',
					email,
					linkStep: true
				});
			}
			console.error('[setup] linking mail account failed:', err);
			return fail(500, { error: describeLinkError(err, serverUrl), email, linkStep: true });
		}

		cookies.set('active_account', account.id, {
			path: '/',
			httpOnly: true,
			secure: true,
			sameSite: 'strict',
			maxAge: 365 * 24 * 60 * 60
		});
		redirect(303, '/inbox');
	}
};
