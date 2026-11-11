import { redirect, type Handle, type HandleServerError, type ServerInit } from '@sveltejs/kit';
import { createHash } from 'node:crypto';
import { building } from '$app/environment';
import { runMigrations } from '$lib/server/db/migrate';
import {
	startReminderScheduler,
	processDueRemindersForUser
} from '$lib/server/reminder-scheduler';
import { startRulesScheduler, applyRulesForUserSafe } from '$lib/server/rules-scheduler';
import { startTrashRetentionScheduler } from '$lib/server/trash-retention';
import { startJevScheduler, sortNewMailSafe } from '$lib/server/jev/worker';
import { startScheduledSendWorker } from '$lib/server/scheduled-send';
import { startPushWorker } from '$lib/server/push/worker';
import { startTelegramWorker } from '$lib/server/telegram/worker';
import { startJobWorker } from '$lib/server/jobs/worker';
import { startSearchIndexer } from '$lib/server/search/worker';
import { getAppSession, verifiedAtMs } from '$lib/server/auth/app-session';
import { SESSION_COOKIE_OPTIONS } from '$lib/server/auth/sign-in';
import { getUserById, hasAppUser } from '$lib/server/auth/user';
import { authStateForAccount, listAccounts, toPublic } from '$lib/server/auth/accounts';
import { assertCryptoReady } from '$lib/server/auth/crypto';
import { errorFields, logEvent } from '$lib/server/log';

// A crash still ends the process as before; this only records why, since
// the container restarts and the console line scrolls away.
process.on('uncaughtExceptionMonitor', (err, origin) => {
	logEvent('error', 'app', 'crash', { origin, ...errorFields(err) });
});

// Run pending DB migrations once per process lifetime — better-sqlite3 is
// synchronous so no promise-caching is required. A failed migration is
// logged by runMigrations itself.
let migrated = false;
let setupDone = false;

// undefined = not yet checked, null = ok, string = the operator-facing error.
let secretError: string | null | undefined;

// Set when a migration failed at start: every request is then refused with
// it, since serving on a half-migrated schema fails later in stranger ways.
let startupError: string | null = null;

// Throttle on-demand reminder checks so we don't hit SQLite on every
// static asset request. Map is process-local; cron handles cross-process
// correctness (there's only ever one node process per container anyway).
const lastDueCheck = new Map<string, number>();
const DUE_CHECK_INTERVAL_MS = 30 * 1000;

// Same idea for the auto-apply rules pass: opportunistic catch-up for active
// users so rules fire within a couple seconds instead of waiting on the cron.
const lastRulesRun = new Map<string, number>();
const RULES_RUN_INTERVAL_MS = 20 * 1000;

// And for Jev sorting new mail into Inbox tabs. Keyed by the account row.
const lastJevRun = new Map<string, number>();
const JEV_RUN_INTERVAL_MS = 20 * 1000;

// BODY_SIZE_LIMIT is set high enough for 25 MB attachments (Dockerfile).
// Nothing a signed-out visitor can post needs more than a form, so they
// keep the old 1 MB limit.
const SIGNED_OUT_BODY_LIMIT = 1024 * 1024;

function tooLargeForSignedOut(request: Request): boolean {
	return Number(request.headers.get('content-length') ?? 0) > SIGNED_OUT_BODY_LIMIT;
}

const PAYLOAD_TOO_LARGE = () => new Response('Payload Too Large', { status: 413 });

// SvelteKit's own CSRF check covers form posts only. The JSON API relied on
// SameSite=Strict, which a sibling subdomain gets past, so any write whose
// Origin names another site is refused. Browsers send Origin on every
// cross-origin write; requests without one are left to the routes.
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function crossSiteWrite(request: Request, url: URL): boolean {
	if (SAFE_METHODS.has(request.method)) return false;
	const origin = request.headers.get('origin');
	return origin !== null && origin !== url.origin;
}

// The session cookie is SameSite=Strict, so the browser leaves it off a
// navigation that another site started: a link from a search result, a chat,
// a web mail client, or a mailto: link handed to this app as its protocol
// handler. That request looks signed out, so /login drew the sign-in form,
// and any deep link was sent to /login, for someone who was signed in all
// along; opening the app again from the address bar then found the session.
//
// Such a page load without the cookie gets a page that loads the same
// address again. That second load comes from this site, so the cookie goes
// with it, and someone who isn't signed in just sees the page they asked for.
//
// What that gives up: a page another site opens now loads signed in, as it
// would with SameSite=Lax (sending the reader to a page was all it could do
// before, too). Only the app's pages get the reload. The API, every write and
// everything a page embeds keep Strict, so another site still can't call the
// API with the session, even by navigating to it.
const RETRY_COOKIE = 'same_site_retry';

// A page load, not a frame: `document` straight from the browser, `empty`
// when the service worker passes the navigation on (it fetches it itself).
const PAGE_DESTINATIONS = new Set(['document', 'empty']);

function crossSiteNavigation(request: Request): boolean {
	const h = request.headers;
	return (
		request.method === 'GET' &&
		h.get('sec-fetch-mode') === 'navigate' &&
		PAGE_DESTINATIONS.has(h.get('sec-fetch-dest') ?? '') &&
		h.get('sec-fetch-site') === 'cross-site'
	);
}

// The app's pages, as against the API, the build's assets and static files.
// Decided on the route SvelteKit matched, not on the address as typed: it
// decodes the path before matching, so `/%61pi/...` is the API too. An
// address starting `//` matches no route and is served as it is (a reload to
// it would name another host). The API stays Strict; and the service worker
// caches some of it (avatars), where a cached reload page would reload itself
// forever.
function isAppPage(event: Parameters<Handle>[0]['event']): boolean {
	const id = event.route.id;
	return id !== null && id !== '/api' && !id.startsWith('/api/') && !event.url.pathname.startsWith('//');
}

// Where the reload goes: this address, path and query only. The fragment
// never reaches the server, and leaving it out is what makes the refresh a
// real load: to the same address with its #fragment, the browser would only
// scroll.
function retryTarget(url: URL): string {
	return url.pathname + url.search;
}

// The retry cookie names the address it was set for, so it only stops a
// second reload of that address, not another tab's or the next link's.
function retryTag(target: string): string {
	return createHash('sha256').update(target).digest('base64url').slice(0, 22);
}

function escapeAttr(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function sameSiteRetry(target: string): Response {
	const href = escapeAttr(target);
	const html =
		'<!doctype html><html><head><meta charset="utf-8">' +
		'<meta name="color-scheme" content="dark light">' +
		`<meta http-equiv="refresh" content="0;url=${href}"><title>Zajel Mail</title></head>` +
		`<body><a href="${href}">Continue to Zajel Mail</a></body></html>`;
	return new Response(html, {
		headers: {
			'content-type': 'text/html; charset=utf-8',
			'cache-control': 'no-store',
			'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
			// Lax, so it comes back even if a browser counted the reload as
			// cross-site too: then the page is served as it is rather than
			// sending the browser round in a loop.
			'set-cookie': `${RETRY_COOKIE}=${retryTag(target)}; Path=/; Max-Age=10; HttpOnly; Secure; SameSite=Lax`
		}
	});
}

// Fail fast on a missing/short WEBMAIL_SECRET: without it linked-account
// passwords can't be encrypted or decrypted, and the breakage would
// otherwise surface mid-flow as misleading "can't reach the mail server"
// errors. One loud, precise error beats a half-working app.
function checkSecret(): void {
	if (secretError !== undefined) return;
	try {
		assertCryptoReady();
		secretError = null;
	} catch (err) {
		secretError = err instanceof Error ? err.message : String(err);
		console.error(`[config] ${secretError}`);
		logEvent('error', 'app', 'config', { error: secretError });
	}
}

// Migrations, then every background worker: Jev's urgent alerts, Telegram,
// reminders, rules, jobs, the search index. Started from the first request,
// as they used to be, they stayed off after a restart until someone opened
// the app.
function startBackground(): void {
	if (migrated) return;
	migrated = true;
	try {
		runMigrations();
	} catch (err) {
		startupError = err instanceof Error ? err.message : String(err);
		console.error(`[startup] ${startupError}`);
		return;
	}
	startReminderScheduler();
	startRulesScheduler();
	startTrashRetentionScheduler();
	startJevScheduler();
	startScheduledSendWorker();
	startPushWorker();
	startTelegramWorker();
	startJobWorker();
	startSearchIndexer();
	logEvent('info', 'app', 'started', { node: process.version });
}

// adapter-node runs this as the server starts, before any request.
export const init: ServerInit = () => {
	if (building) return;
	checkSecret();
	if (!secretError) startBackground();
};

export const handle: Handle = async ({ event, resolve }) => {
	checkSecret();
	if (secretError) {
		return new Response(secretError, { status: 500 });
	}
	// Normally already done by init; the dev server can skip it.
	startBackground();
	if (startupError) {
		return new Response(startupError, { status: 500 });
	}

	const { pathname } = event.url;

	if (crossSiteWrite(event.request, event.url)) {
		logEvent('warn', 'http', 'cross_site_refused', {
			method: event.request.method,
			path: pathname,
			origin: event.request.headers.get('origin'),
			expected: event.url.origin
		});
		return new Response('Cross-site request refused', { status: 403 });
	}

	// First-run gate: until the master user exists, everything funnels to
	// /setup (API calls get their 401s from their own auth checks). The
	// flag is sticky once true so steady state skips the COUNT query.
	if (!setupDone) setupDone = hasAppUser();
	if (!setupDone) {
		if (pathname !== '/setup' && !pathname.startsWith('/api')) {
			redirect(303, '/setup');
		}
		if (tooLargeForSignedOut(event.request)) return PAYLOAD_TOO_LARGE();
		return resolve(event);
	}

	const sessionId = event.cookies.get('session');
	// The reload of an address that got the retry page spends its cookie,
	// whichever site the browser says it came from, so the next link to the
	// same address is retried too. Counted as cross-site again, it is served
	// as it is rather than going round in a loop.
	const tag = event.cookies.get(RETRY_COOKIE);
	const reloaded = tag !== undefined && tag === retryTag(retryTarget(event.url));
	if (reloaded) event.cookies.delete(RETRY_COOKIE, { path: '/' });
	if (!sessionId && !reloaded && crossSiteNavigation(event.request) && isAppPage(event)) {
		return sameSiteRetry(retryTarget(event.url));
	}
	if (sessionId) {
		const session = getAppSession(sessionId);
		const user = session ? getUserById(session.user_id) : undefined;
		if (session && user) {
			event.locals.user = user;
			event.locals.sessionId = session.id;
			event.locals.sessionVerifiedAt = verifiedAtMs(session);
			// The server just slid expires_at forward; the cookie's own lifetime
			// has to follow, or the browser drops it 30 days after sign-in however
			// active the person is, and the row lingers as a phantom device.
			if (session.extended) event.cookies.set('session', session.id, SESSION_COOKIE_OPTIONS);

			const accounts = listAccounts(user.id);
			event.locals.accounts = accounts.map(toPublic);

			// Active account: cookie wins if it still points at a linked
			// account; otherwise fall back to the first (default) one.
			const cookieId = event.cookies.get('active_account');
			const active = accounts.find((a) => a.id === cookieId) ?? accounts[0];
			if (active && active.needs_reauth !== 1) {
				try {
					event.locals.auth = authStateForAccount(active);
					event.locals.activeAccountId = active.id;
				} catch {
					// Undecryptable secret (rotated WEBMAIL_SECRET) — leave
					// auth unset; the layout sends the user to /reauth.
					event.locals.activeAccountId = active.id;
				}
			} else if (active) {
				event.locals.activeAccountId = active.id;
			}

			// Opportunistic catch-up for the active account: if the cron tick
			// hasn't run yet but a reminder is already past due, process it
			// before the request continues so the user doesn't wait 60s.
			if (event.locals.auth && active) {
				const userEmail = active.email;
				const auth = event.locals.auth;
				const last = lastDueCheck.get(userEmail) ?? 0;
				if (Date.now() - last > DUE_CHECK_INTERVAL_MS) {
					lastDueCheck.set(userEmail, Date.now());
					// Fire and forget — never block the request on this.
					void processDueRemindersForUser(auth, userEmail);
				}

				const lastRules = lastRulesRun.get(userEmail) ?? 0;
				if (Date.now() - lastRules > RULES_RUN_INTERVAL_MS) {
					lastRulesRun.set(userEmail, Date.now());
					void applyRulesForUserSafe(auth, userEmail);
				}

				const lastJev = lastJevRun.get(active.id) ?? 0;
				if (Date.now() - lastJev > JEV_RUN_INTERVAL_MS) {
					lastJevRun.set(active.id, Date.now());
					void sortNewMailSafe(active.id, active.email, auth);
				}
			}
		} else {
			event.cookies.delete('session', { path: '/' });
		}
	}

	if (!event.locals.user && tooLargeForSignedOut(event.request)) return PAYLOAD_TOO_LARGE();
	const response = await resolve(event);
	// A page another site opens now loads signed in (see sameSiteRetry), so it
	// must not keep a handle on the window: through one it could count the
	// open message's frames or navigate it under the reader's next click.
	if (response.headers.get('content-type')?.startsWith('text/html')) {
		try {
			response.headers.set('cross-origin-opener-policy', 'same-origin');
		} catch {
			// A response passed through from a fetch() keeps immutable headers.
		}
	}
	return response;
};

// SvelteKit's own handler only prints to the console; this keeps that and
// adds the event to the log file. Unknown paths (404s) stay out of it, since
// scanners produce them all day.
export const handleError: HandleServerError = ({ error, event, status, message }) => {
	if (status === 404) {
		console.error((error as Error | undefined)?.message ?? error);
		return { message };
	}
	console.error(error);
	logEvent('error', 'http', 'unhandled', {
		method: event.request.method,
		path: event.url.pathname,
		status,
		...errorFields(error)
	});
	return { message };
};
