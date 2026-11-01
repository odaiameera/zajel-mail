/** Cookie settings shared by every way of signing in. */

export const SESSION_COOKIE_OPTIONS = {
	path: '/',
	httpOnly: true,
	secure: true,
	sameSite: 'strict',
	maxAge: 30 * 24 * 60 * 60
} as const;

/** Holds the id of a second step that is waiting after a correct password. */
export const MFA_COOKIE = 'mfa';

export const MFA_COOKIE_OPTIONS = {
	path: '/',
	httpOnly: true,
	secure: true,
	sameSite: 'strict',
	maxAge: 5 * 60
} as const;
