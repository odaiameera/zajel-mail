import cron from 'node-cron';
import { JMAPAuthError } from '$lib/jmap/client';
import type { AuthState } from '$lib/jmap/types';
import { listSchedulableAuths, markNeedsReauth } from '$lib/server/auth/accounts';
import { pruneOldAutoReplies } from '$lib/server/auto-reply';
import { errorFields } from '$lib/server/log';
import { noteFailure, noteRecovered } from '$lib/server/jev/health';
import { runPass, type PassOptions } from './pass';
import { pruneArrivals } from './arrivals';
import { refreshStreams, startStreams } from './stream';

/**
 * The one pipeline for new mail: out-of-office, rules and Jev, a pass per
 * account (see pass.ts). Passes run within seconds of delivery from each
 * account's event stream (stream.ts), every minute for every account, and
 * as a catch-up for whoever is using the app (hooks.server.ts).
 */

export type { PassOptions } from './pass';

let started = false;
const inFlight = new Set<string>();
// A pass asked for while one was running: run once more when it ends, as
// the running one may have read the Inbox before the mail that asked.
const rerun = new Map<string, { auth: AuthState; opts: PassOptions }>();

/**
 * One account's pass, never throwing. Passes for one account don't
 * overlap: one asked for while another runs is run once, straight after it
 * (as a scheduled pass if any of those asking wanted one). A refused
 * password marks the account for signing in again and stops; any other
 * failure is logged once while it lasts, and the next pass tries again.
 */
export async function requestPass(accountRowId: string, auth: AuthState, opts: PassOptions = {}): Promise<void> {
	if (inFlight.has(accountRowId)) {
		const queued = rerun.get(accountRowId);
		const fromStream = !!opts.fromStream && (queued ? !!queued.opts.fromStream : true);
		rerun.set(accountRowId, { auth, opts: { fromStream } });
		return;
	}
	inFlight.add(accountRowId);
	try {
		for (let next: { auth: AuthState; opts: PassOptions } | undefined = { auth, opts }; next; ) {
			rerun.delete(accountRowId);
			try {
				await runPass(accountRowId, next.auth, next.opts);
				noteRecovered('pass', accountRowId, 'pass_recovered');
			} catch (err) {
				// A 401 is logged, and sent to Telegram, by markNeedsReauth.
				if (err instanceof JMAPAuthError) {
					markNeedsReauth(accountRowId);
					break;
				}
				console.error('[mail] new-mail pass failed', accountRowId, err);
				noteFailure('pass', accountRowId, 'pass_failed', errorFields(err));
			}
			next = rerun.get(accountRowId);
		}
	} finally {
		rerun.delete(accountRowId);
		inFlight.delete(accountRowId);
	}
}

/**
 * The minute's run: every account's pass, side by side, so one account
 * waiting on a slow Jev call never holds up another's rules.
 */
export async function runScheduledPasses(): Promise<void> {
	await Promise.all(listSchedulableAuths().map(({ account, auth }) => requestPass(account.id, auth)));
}

/** Open or close event streams after a change to what acts on new mail (rules, out-of-office, Jev, pins). */
export function refreshPipeline(): void {
	refreshStreams();
}

export function startMailPipeline(): void {
	if (started) return;
	started = true;
	// Handle new mail as it lands, not only on the minute.
	startStreams(requestPass);
	cron.schedule('* * * * *', () => runScheduledPasses());
	// The daily pass: the out-of-office log is kept a month, arrivals a week.
	cron.schedule('41 3 * * *', () => {
		try {
			pruneOldAutoReplies();
			pruneArrivals();
		} catch (err) {
			console.error('[mail] daily prune failed', err);
		}
	});
}
