import type { Cookies } from '@sveltejs/kit';

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

/**
 * Where someone was going when the app sent them to sign in: a message a
 * Telegram alert or a notification points at, a mail link, a bookmark. Kept
 * for as long as signing in can take, so they land there and not on the
 * inbox. A cookie, not a `?next=` on /login: signing in is several requests
 * (password, then a code or a passkey), and each would have to carry it on.
 */
export const RETURN_COOKIE = 'return_to';

const RETURN_COOKIE_OPTIONS = {
	path: '/',
	httpOnly: true,
	secure: true,
	// Lax: it is set on the answer to a link from anywhere, and read on a
	// form post from this site. It names a page here and nothing else.
	sameSite: 'lax',
	maxAge: 15 * 60
} as const;

/** Where signing in leads when nowhere was asked for. */
export const HOME = '/inbox';

// A cookie goes out in a response header and comes back in a request header,
// and proxies cap both (nginx: 4 KB of response head by default). An address
// longer than this is let go, and signing in leads to the inbox as before.
const RETURN_MAX_LENGTH = 1500;

/**
 * An address signing in may lead to: a path on this site, and one of the
 * app's pages. Anything else (another host written as `//host` or `/\host`,
 * the API, the sign-in pages themselves) is refused, since a cookie can be
 * planted by a page on a sibling subdomain.
 */
export function safeReturn(target: string | undefined): string | null {
	if (!target || target.length > RETURN_MAX_LENGTH) return null;
	if (!/^\/(?![/\\])[\x21-\x7e]*$/.test(target) || target.includes('\\')) return null;
	// Judged as the router will read it: `/%61pi/...` is the API too.
	let path: string;
	try {
		path = decodeURIComponent(target.split(/[?#]/, 1)[0]);
	} catch {
		return null;
	}
	if (/^\/(api|login|logout|setup|reauth)(\/|$)/i.test(path) || /^\/[/\\]/.test(path)) return null;
	return target;
}

/**
 * Remember the address a signed-out visitor asked for. The latest one counts:
 * asking for the inbox, or for an address that can't be kept, forgets an
 * earlier one, so signing in never leads somewhere asked for a while ago.
 */
export function rememberReturn(cookies: Cookies, url: URL): void {
	const target = safeReturn(url.pathname + url.search);
	if (target && target !== HOME) cookies.set(RETURN_COOKIE, target, RETURN_COOKIE_OPTIONS);
	else if (cookies.get(RETURN_COOKIE) !== undefined) cookies.delete(RETURN_COOKIE, { path: '/' });
}

/** Where to go now that sign-in is done; the remembered address is used once. */
export function takeReturn(cookies: Cookies): string {
	const stored = cookies.get(RETURN_COOKIE);
	if (stored === undefined) return HOME;
	cookies.delete(RETURN_COOKIE, { path: '/' });
	return safeReturn(stored) ?? HOME;
}
