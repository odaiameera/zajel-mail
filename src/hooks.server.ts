import { redirect, type Handle } from '@sveltejs/kit';
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
import { getAppSession } from '$lib/server/auth/app-session';
import { getUserById, hasAppUser } from '$lib/server/auth/user';
import { authStateForAccount, listAccounts, toPublic } from '$lib/server/auth/accounts';
import { assertCryptoReady } from '$lib/server/auth/crypto';

// Run pending DB migrations once per process lifetime — better-sqlite3 is
// synchronous so no promise-caching is required. Silent by design (the
// spec calls for no log output); failures surface through subsequent
// query errors rather than hot-path noise.
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

export const handle: Handle = async ({ event, resolve }) => {
	// Fail fast on a missing/short WEBMAIL_SECRET: without it linked-account
	// passwords can't be encrypted or decrypted, and the breakage would
	// otherwise surface mid-flow as misleading "can't reach the mail server"
	// errors. One loud, precise error beats a half-working app.
	if (secretError === undefined) {
		try {
			assertCryptoReady();
			secretError = null;
		} catch (err) {
			secretError = err instanceof Error ? err.message : String(err);
			console.error(`[config] ${secretError}`);
		}
	}
	if (secretError) {
		return new Response(secretError, { status: 500 });
	}

	if (!migrated) {
		runMigrations();
		startReminderScheduler();
		startRulesScheduler();
		startTrashRetentionScheduler();
		startJevScheduler();
		startScheduledSendWorker();
		startPushWorker();
		migrated = true;
	}

	const { pathname } = event.url;

	// First-run gate: until the master user exists, everything funnels to
	// /setup (API calls get their 401s from their own auth checks). The
	// flag is sticky once true so steady state skips the COUNT query.
	if (!setupDone) setupDone = hasAppUser();
	if (!setupDone) {
		if (pathname !== '/setup' && !pathname.startsWith('/api')) {
			redirect(303, '/setup');
		}
		return resolve(event);
	}

	const sessionId = event.cookies.get('session');
	if (sessionId) {
		const session = getAppSession(sessionId);
		const user = session ? getUserById(session.user_id) : undefined;
		if (session && user) {
			event.locals.user = user;
			event.locals.sessionId = session.id;

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

	return resolve(event);
};
