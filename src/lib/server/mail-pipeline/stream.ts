import { JMAPAuthError } from '$lib/jmap/client';
import type { AuthState } from '$lib/jmap/types';
import { listSchedulableAuths, markNeedsReauth } from '$lib/server/auth/accounts';
import { pipelineNeeds } from './needs';

/**
 * Handling new mail within seconds of delivery, not on the next one-minute
 * run. For each account a pass has work for, the server holds the mail
 * server's push channel open (the one /api/events proxies for the browser)
 * and runs a pass a moment after each Email change. That is what keeps the
 * Inbox's hold on new mail (see `$lib/inbox-hold`) down to seconds. The
 * one-minute run stays, for a stream that is down.
 *
 * The pass's own writes are Email changes too, so a pass that changed
 * something is followed by one that finds nothing new and writes nothing,
 * which ends it. That is also why these passes leave existing mail alone,
 * and why they stop calling TypeSafe while it is failing (see PassOptions
 * in pass.ts).
 */

/** Gathers a burst of changes (a delivery, then the server's own filing) into one pass. */
const PASS_DEBOUNCE_MS = 1_000;
const PING_SECONDS = 60;
/** No bytes, not even a ping, for this long: the stream is dead. */
const STALL_MS = PING_SECONDS * 3 * 1000;
const MIN_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 5 * 60_000;
const RECONCILE_MS = 60_000;

/** The pipeline's never-throwing pass, told it was asked for by the stream (see PassOptions in pass.ts). */
export type RunPass = (accountRowId: string, auth: AuthState, opts: { fromStream: true }) => Promise<void>;

interface Target {
	id: string;
	email: string;
	auth: AuthState;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms).unref?.());
}

class Watcher {
	private stopped = false;
	private abort: AbortController | null = null;
	private debounce: ReturnType<typeof setTimeout> | null = null;

	constructor(
		public target: Target,
		private runPass: RunPass
	) {}

	get isStopped(): boolean {
		return this.stopped;
	}

	start(): void {
		void this.run();
	}

	stop(): void {
		this.stopped = true;
		this.abort?.abort();
		if (this.debounce) clearTimeout(this.debounce);
	}

	private schedulePass(): void {
		if (this.stopped) return;
		if (this.debounce) clearTimeout(this.debounce);
		this.debounce = setTimeout(() => {
			this.debounce = null;
			const { id, auth } = this.target;
			// The pass never throws; this is only a guard.
			this.runPass(id, auth, { fromStream: true }).catch(() => {});
		}, PASS_DEBOUNCE_MS);
		this.debounce.unref?.();
	}

	private async run(): Promise<void> {
		let backoff = MIN_BACKOFF_MS;
		while (!this.stopped) {
			try {
				await this.listen(() => {
					backoff = MIN_BACKOFF_MS;
				});
			} catch (err) {
				if (this.stopped) return;
				if (err instanceof JMAPAuthError) {
					markNeedsReauth(this.target.id);
					this.stop();
					return;
				}
				if (backoff > MIN_BACKOFF_MS || (err as Error).name !== 'AbortError') {
					console.warn(`[mail] event stream for ${this.target.email}: ${(err as Error).message}`);
				}
			}
			if (this.stopped) return;
			await sleep(backoff);
			backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
		}
	}

	/** Hold the account's event stream open until it ends, stalls or is stopped. */
	private async listen(onOpen: () => void): Promise<void> {
		const controller = new AbortController();
		this.abort = controller;
		let stall: ReturnType<typeof setTimeout> | undefined;
		const resetStall = () => {
			clearTimeout(stall);
			stall = setTimeout(() => controller.abort(), STALL_MS);
			stall.unref?.();
		};
		try {
			const { auth } = this.target;
			const res = await fetch(`${auth.apiUrl}eventsource/?types=Email&closeafter=no&ping=${PING_SECONDS}`, {
				headers: { Authorization: auth.authHeader, Accept: 'text/event-stream' },
				signal: controller.signal
			});
			if (res.status === 401) throw new JMAPAuthError('Authentication failed');
			if (!res.ok || !res.body) throw new Error(`event stream ${res.status}`);
			onOpen();
			// Mail may have landed while the stream was down.
			this.schedulePass();
			resetStall();

			const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
			let buffer = '';
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				resetStall();
				buffer += value.replace(/\r/g, '');
				let end: number;
				while ((end = buffer.indexOf('\n\n')) !== -1) {
					const event = buffer.slice(0, end);
					buffer = buffer.slice(end + 2);
					if (/^event:\s*state\s*$/m.test(event)) this.schedulePass();
				}
			}
		} finally {
			clearTimeout(stall);
		}
	}
}

interface StreamState {
	watchers: Map<string, Watcher>;
	runPass: RunPass;
}

// On globalThis, so a dev-server reload doesn't open a second set of
// streams (restart the dev server after changing this file).
const STATE_KEY = Symbol.for('zajel.mailStreams');

function state(): StreamState | undefined {
	return (globalThis as Record<symbol, StreamState | undefined>)[STATE_KEY];
}

/**
 * Accounts a pass has work for: those that let Jev read their mail, while
 * Jev can answer at all, and those whose Inbox is holding new mail. The
 * second kind needs no Jev: without a stream, every new message in such an
 * Inbox would wait for the once-a-minute run.
 */
function desiredTargets(): Map<string, Target> {
	const out = new Map<string, Target>();
	for (const { account, auth } of listSchedulableAuths()) {
		const needs = pipelineNeeds(account.id);
		if (needs.jev || needs.hold) {
			out.set(account.id, { id: account.id, email: account.email, auth });
		}
	}
	return out;
}

/** Open or close streams to match which accounts have new mail to handle now. */
export function refreshStreams(): void {
	const s = state();
	if (!s) return;
	try {
		const desired = desiredTargets();
		for (const [id, watcher] of s.watchers) {
			const next = desired.get(id);
			// A watcher that gave up (its password was refused) is replaced,
			// so an account linked again gets its stream back.
			if (!next || watcher.isStopped) {
				watcher.stop();
				s.watchers.delete(id);
			} else {
				// Fresh credentials for the next reconnect.
				watcher.target = next;
			}
		}
		for (const [id, target] of desired) {
			if (s.watchers.has(id)) continue;
			const watcher = new Watcher(target, s.runPass);
			s.watchers.set(id, watcher);
			watcher.start();
		}
	} catch (err) {
		console.error('[mail] event streams: reconcile failed', err);
	}
}

/** Start watching; `runPass` is the pipeline's never-throwing pass. */
export function startStreams(runPass: RunPass): void {
	if (state()) return;
	(globalThis as Record<symbol, StreamState>)[STATE_KEY] = { watchers: new Map(), runPass };
	refreshStreams();
	setInterval(refreshStreams, RECONCILE_MS).unref?.();
}

/** Close every stream and forget them: for tests. */
export function stopStreams(): void {
	const s = state();
	if (!s) return;
	for (const watcher of s.watchers.values()) watcher.stop();
	delete (globalThis as Record<symbol, StreamState | undefined>)[STATE_KEY];
}
