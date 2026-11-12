import cron from 'node-cron';
import { JMAPAuthError } from '$lib/jmap/client';
import type { AuthState } from '$lib/jmap/types';
import { listAllMailAccounts, listSchedulableAuths, markNeedsReauth } from '$lib/server/auth/accounts';
import { pruneOldAutoReplies } from '$lib/server/auto-reply';
import { errorFields } from '$lib/server/log';
import { noteFailure, noteRecovered } from '$lib/server/jev/health';
import { runPass, type PassOptions } from './pass';
import { keepHoldInStep, pruneArrivals } from './arrivals';
import { pipelineNeeds } from './needs';
import { refreshStreams, startStreams } from './stream';

/**
 * The one pipeline for new mail: out-of-office, rules and Jev, a pass per
 * account (see pass.ts). Passes run within seconds of delivery from each
 * account's event stream (stream.ts), every minute for every account, and
 * as a catch-up for whoever is using the app (hooks.server.ts).
 */

export type { PassOptions } from './pass';

interface PipelineState {
	started: boolean;
	/** Accounts with a pass running. */
	inFlight: Set<string>;
	/**
	 * A pass asked for while one was running: run once more when it ends, as
	 * the running one may have read the Inbox before the mail that asked.
	 */
	rerun: Map<string, { auth: AuthState; opts: PassOptions }>;
}

// On globalThis, as the streams are (see stream.ts), so a dev-server reload
// that loads this module again can't start a second minute's run, or let a
// second pass for an account run beside one already running.
const STATE_KEY = Symbol.for('zajel.mailPipeline');
const globals = globalThis as Record<symbol, PipelineState | undefined>;
const pipeline = (globals[STATE_KEY] ??= { started: false, inFlight: new Set(), rerun: new Map() });
const { inFlight, rerun } = pipeline;

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
				noteRecovered('pass', accountRowId, 'pass_recovered', 'mail');
			} catch (err) {
				// A 401 is logged, and sent to Telegram, by markNeedsReauth.
				if (err instanceof JMAPAuthError) {
					markNeedsReauth(accountRowId);
					break;
				}
				console.error('[mail] new-mail pass failed', accountRowId, err);
				noteFailure('pass', accountRowId, 'pass_failed', errorFields(err), 'mail');
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

/**
 * After a change to what acts on new mail (rules, out-of-office, Jev,
 * pins, the tabs): note when the Inbox's hold switched on or off for each
 * account, so mail that was already showing stays shown, and open or close
 * event streams to match.
 */
export function refreshPipeline(now = new Date()): void {
	for (const account of listAllMailAccounts()) {
		try {
			keepHoldInStep(account.id, pipelineNeeds(account.id, now).hold, now);
		} catch (err) {
			console.error('[mail] could not note the Inbox hold', account.id, err);
		}
	}
	refreshStreams();
}

export function startMailPipeline(): void {
	if (pipeline.started) return;
	pipeline.started = true;
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
