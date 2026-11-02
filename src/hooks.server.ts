import { redirect, type Handle, type HandleServerError, type ServerInit } from '@sveltejs/kit';
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
	runMigrations();
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
	if (sessionId) {
		const session = getAppSession(sessionId);
		const user = session ? getUserById(session.user_id) : undefined;
		if (session && user) {
			event.locals.user = user;
			event.locals.sessionId = session.id;
			event.locals.sessionVerifiedAt = verifiedAtMs(session);

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
					void applyRulesForUserSafe(auth, userEmail, active.id);
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
	return resolve(event);
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
