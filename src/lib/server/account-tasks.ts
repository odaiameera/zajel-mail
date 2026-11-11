import { createClient, fetchSession } from '$lib/jmap/auth';
import type { AuthState } from '$lib/jmap/types';
import { isAccountTaskDone, markAccountTaskDone } from './db/queries/account-tasks';
import { errorFields, logEvent } from './log';

/**
 * One-time jobs for a mail account that need its credentials, run at the
 * start of the account's new-mail pass (see mail-pipeline/pass.ts), which
 * has them. Each runs until it succeeds once and is then never run again
 * for that account. A failure never stops the pass; the task is tried
 * again an hour later, not on
 * every minute's run, so a server that keeps failing isn't asked (and the
 * log isn't written) sixty times an hour. The wait is kept in memory: a
 * restart may try once more straight away.
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** Per account and task: when to try next, and when the failure was last logged. */
const backoff = new Map<string, { retryAt: number; warnedAt: number }>();

const SIEVE = 'urn:ietf:params:jmap:sieve';
const SIEVE_USING = ['urn:ietf:params:jmap:core', SIEVE];
/** The name Zajel uploaded its rules under, when it compiled them to Sieve. */
const OUR_SCRIPT = 'mailrules';

interface SieveScriptEntry {
	id: string;
	name: string;
	isActive?: boolean;
}

/**
 * Rules once also went to the mail server as a Sieve script, which this
 * server never ran, and activating it switched off any script made in
 * another mail client. The app runs the rules itself now, so the script it
 * left behind is taken away: switched off if it is the active one, then
 * deleted. A script with any other name is never touched. A server without
 * Sieve has nothing to take away, so that counts as done.
 */
export async function retireSieveScript(auth: AuthState): Promise<void> {
	const session = await fetchSession(auth);
	const accountCaps = session.accounts?.[auth.accountId]?.accountCapabilities;
	if (!(SIEVE in (session.capabilities ?? {})) || (accountCaps && !(SIEVE in accountCaps))) return;

	const client = createClient(auth);
	const { accountId } = auth;
	const got = await client.request([['SieveScript/get', { accountId, ids: null }, '0']], SIEVE_USING);
	const scripts = (got.methodResponses[0][1] as { list?: SieveScriptEntry[] }).list ?? [];
	const ours = scripts.find((s) => s.name === OUR_SCRIPT);
	if (!ours) return;

	// The scripts could change between the read above and this call (another
	// client activating its own script in that moment); the window is tiny
	// and the worst case is that script being switched off, so it is left.
	// An active script can't be destroyed, so ours is switched off first,
	// in its own call: `onSuccessDeactivateScript` switches off whichever
	// script is active, which is only asked for when that one is ours.
	const calls: [string, Record<string, unknown>, string][] = [];
	if (ours.isActive) calls.push(['SieveScript/set', { accountId, onSuccessDeactivateScript: true }, 'off']);
	calls.push(['SieveScript/set', { accountId, destroy: [ours.id] }, 'rm']);
	const set = await client.request(calls, SIEVE_USING);
	const result = set.methodResponses.at(-1)![1] as {
		notDestroyed?: Record<string, { type?: string; description?: string }> | null;
	};
	const refused = Object.values(result.notDestroyed ?? {})[0];
	if (refused) throw new Error(`the server kept the script: ${refused.description ?? refused.type ?? 'refused'}`);
}

const TASKS: { name: string; run: (auth: AuthState) => Promise<void> }[] = [
	{ name: 'retire_sieve_script', run: retireSieveScript }
];

/** Run the account's tasks that haven't succeeded yet and aren't waiting after a failure. Never throws. */
export async function runAccountTasks(auth: AuthState, accountId: string, now = Date.now()): Promise<void> {
	for (const task of TASKS) {
		if (isAccountTaskDone(accountId, task.name)) continue;
		const key = `${accountId}:${task.name}`;
		const waiting = backoff.get(key);
		if (waiting && now < waiting.retryAt) continue;
		try {
			await task.run(auth);
			markAccountTaskDone(accountId, task.name);
			backoff.delete(key);
			logEvent('info', 'rules', 'account_task_done', { task: task.name, account: accountId });
		} catch (err) {
			// Logged the first time, then at most once a day while it keeps failing.
			const warn = !waiting || now - waiting.warnedAt >= DAY;
			backoff.set(key, { retryAt: now + HOUR, warnedAt: warn ? now : waiting.warnedAt });
			if (warn) {
				console.warn(`[mail] account ${accountId}: ${task.name} failed, will try again in an hour`, err);
				logEvent('warn', 'rules', 'account_task_failed', { task: task.name, account: accountId, ...errorFields(err) });
			}
		}
	}
}
