import { JMAPAuthError } from '$lib/jmap/client';
import { createClient } from '$lib/jmap/auth';
import { getMailboxes } from '$lib/jmap/mailbox';
import type { AuthState, Email } from '$lib/jmap/types';
import {
	authStateForAccount,
	listAccounts,
	markNeedsReauth,
	type MailAccountRow
} from '../auth/accounts';
import { getPrefs } from '../db/queries/app-prefs';
import { usersWithPushSubscriptions } from '../db/queries/push';
import { upcomingReminders } from '../calendar/service';
import { sendPushToUser, type PushPayload } from './send';

/**
 * Push notifications for new mail and event reminders, sent from the server
 * so they arrive while Zajel Mail is closed — the phone in a pocket, the
 * Home Screen app suspended. Only users with a subscribed device and
 * notifications on in Settings are watched.
 *
 * Mail: one JMAP event stream per watched account (the same push channel
 * the open app listens to through /api/events). Each Email state change
 * runs one query for unread mail in the folders picked under Settings →
 * Notifications that arrived since the last check.
 *
 * Reminders: every few minutes the next window's VALARMs are fetched and
 * each gets a timer, the way the open app schedules them locally.
 */

const RECONCILE_MS = 60_000;
const REMINDER_POLL_MS = 5 * 60_000;
const REMINDER_HORIZON_MS = REMINDER_POLL_MS + 60_000;
const SENT_REMINDER_TTL_MS = 2 * 86_400_000;
/** Gathers a burst of state changes (delivery, then Jev or rules moving it) into one check. */
const CHECK_DEBOUNCE_MS = 2_000;
const PING_SECONDS = 60;
/** No bytes, not even a ping, for this long: the stream is dead. */
const STALL_MS = PING_SECONDS * 3 * 1000;
const MIN_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 5 * 60_000;
const MAILBOX_CACHE_MS = 10 * 60_000;
/** More new messages than this in one check become one summary. */
const MAX_SEPARATE = 3;
const NOTIFIED_MEMORY = 500;

interface Target {
	account: MailAccountRow;
	userId: string;
	/** The user has more than one linked account. */
	multiAccount: boolean;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms).unref?.());
}

function wantsNotifications(userId: string): Record<string, string> | null {
	const prefs = getPrefs(userId);
	return prefs.notifications === 'on' ? prefs : null;
}

/** Accounts that should be watched right now, by account id. */
function desiredTargets(): Map<string, Target> {
	const out = new Map<string, Target>();
	for (const userId of usersWithPushSubscriptions()) {
		if (!wantsNotifications(userId)) continue;
		const accounts = listAccounts(userId).filter((a) => a.needs_reauth !== 1);
		for (const account of accounts) {
			out.set(account.id, { account, userId, multiAccount: accounts.length > 1 });
		}
	}
	return out;
}

function senderOf(email: Email): string {
	const from = email.from?.[0];
	return from?.name?.trim() || from?.email || 'New message';
}

class MailWatcher {
	private stopped = false;
	private abort: AbortController | null = null;
	private debounce: ReturnType<typeof setTimeout> | null = null;
	private checking = false;
	private again = false;
	/** receivedAt cut-off for the next query; set from the server's own newest mail. */
	private since: string | null = null;
	private notified: string[] = [];
	private mailboxes: { ids: Set<string>; inbox: string | null; at: number } | null = null;

	constructor(public target: Target) {}

	start(): void {
		void this.run();
	}

	stop(): void {
		this.stopped = true;
		this.abort?.abort();
		if (this.debounce) clearTimeout(this.debounce);
	}

	private auth(): AuthState | null {
		try {
			return authStateForAccount(this.target.account);
		} catch {
			// Undecryptable secret — the account needs re-linking.
			return null;
		}
	}

	private giveUp(err: unknown): boolean {
		if (err instanceof JMAPAuthError) {
			markNeedsReauth(this.target.account.id);
			this.stop();
			return true;
		}
		return false;
	}

	private async run(): Promise<void> {
		let backoff = MIN_BACKOFF_MS;
		while (!this.stopped) {
			const auth = this.auth();
			if (!auth) return;
			try {
				if (this.since === null) await this.baseline(auth);
				await this.listen(auth, () => { backoff = MIN_BACKOFF_MS; });
			} catch (err) {
				if (this.stopped || this.giveUp(err)) return;
				if (backoff > MIN_BACKOFF_MS || (err as Error).name !== 'AbortError') {
					console.warn(`[push] ${this.target.account.email}: ${(err as Error).message}`);
				}
			}
			if (this.stopped) return;
			await sleep(backoff);
			backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
		}
	}

	/** Hold the account's event stream open until it ends, stalls or is stopped. */
	private async listen(auth: AuthState, onOpen: () => void): Promise<void> {
		const controller = new AbortController();
		this.abort = controller;
		let stall: ReturnType<typeof setTimeout> | undefined;
		const resetStall = () => {
			clearTimeout(stall);
			stall = setTimeout(() => controller.abort(), STALL_MS);
		};
		try {
			const res = await fetch(
				`${auth.apiUrl}eventsource/?types=Email&closeafter=no&ping=${PING_SECONDS}`,
				{
					headers: { Authorization: auth.authHeader, Accept: 'text/event-stream' },
					signal: controller.signal
				}
			);
			if (res.status === 401) throw new JMAPAuthError('Authentication failed');
			if (!res.ok || !res.body) throw new Error(`event stream ${res.status}`);
			console.log(`[push] watching ${this.target.account.email}`);
			onOpen();
			// Mail may have arrived while the stream was down.
			this.scheduleCheck();
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
					if (/^event:\s*state\s*$/m.test(event)) this.scheduleCheck();
				}
			}
		} finally {
			clearTimeout(stall);
		}
	}

	private scheduleCheck(): void {
		if (this.debounce) clearTimeout(this.debounce);
		this.debounce = setTimeout(() => void this.check(), CHECK_DEBOUNCE_MS);
	}

	private async check(): Promise<void> {
		if (this.checking) {
			this.again = true;
			return;
		}
		this.checking = true;
		try {
			do {
				this.again = false;
				await this.checkOnce();
			} while (this.again && !this.stopped);
		} catch (err) {
			if (!this.giveUp(err)) console.warn('[push] mail check failed', (err as Error).message);
		} finally {
			this.checking = false;
		}
	}

	/** The folders picked in Settings that belong to this account; Inbox if none do. */
	private async folderIds(auth: AuthState, prefs: Record<string, string>): Promise<string[]> {
		if (!this.mailboxes || Date.now() - this.mailboxes.at > MAILBOX_CACHE_MS) {
			const list = await getMailboxes(createClient(auth), auth.accountId);
			this.mailboxes = {
				ids: new Set(list.map((m) => m.id)),
				inbox: list.find((m) => m.role === 'inbox')?.id ?? null,
				at: Date.now()
			};
		}
		let picked: string[] = [];
		try {
			const parsed = JSON.parse(prefs.notification_folders ?? '[]');
			if (Array.isArray(parsed)) picked = parsed.filter((id) => this.mailboxes!.ids.has(id));
		} catch {
			// Malformed pref — fall back to Inbox.
		}
		if (picked.length > 0) return picked;
		return this.mailboxes.inbox ? [this.mailboxes.inbox] : [];
	}

	private filterFor(folders: string[], extra: object[]): object {
		const inFolders =
			folders.length === 1
				? { inMailbox: folders[0] }
				: { operator: 'OR', conditions: folders.map((id) => ({ inMailbox: id })) };
		return { operator: 'AND', conditions: [inFolders, ...extra] };
	}

	/** Start from the newest mail already there, by the mail server's clock. */
	private async baseline(auth: AuthState): Promise<void> {
		const prefs = wantsNotifications(this.target.userId) ?? {};
		const folders = await this.folderIds(auth, prefs);
		if (folders.length === 0) {
			this.since = new Date().toISOString();
			return;
		}
		const res = await createClient(auth).request([
			[
				'Email/query',
				{
					accountId: auth.accountId,
					filter: this.filterFor(folders, []),
					sort: [{ property: 'receivedAt', isAscending: false }],
					limit: 1
				},
				'q'
			],
			[
				'Email/get',
				{
					accountId: auth.accountId,
					'#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' },
					properties: ['id', 'receivedAt']
				},
				'g'
			]
		]);
		const newest = (res.methodResponses[1][1] as { list?: Email[] }).list?.[0];
		if (newest) this.remember([newest.id]);
		this.since = newest?.receivedAt ?? new Date().toISOString();
	}

	private remember(ids: string[]): void {
		this.notified.push(...ids);
		if (this.notified.length > NOTIFIED_MEMORY) this.notified.splice(0, this.notified.length - NOTIFIED_MEMORY);
	}

	private async checkOnce(): Promise<void> {
		const prefs = wantsNotifications(this.target.userId);
		const auth = this.auth();
		if (!prefs || !auth || this.since === null) return;
		const folders = await this.folderIds(auth, prefs);
		if (folders.length === 0) return;

		// A second's overlap keeps two messages delivered in the same second
		// apart; anything already sent is remembered.
		const after = new Date(Date.parse(this.since) - 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
		const res = await createClient(auth).request([
			[
				'Email/query',
				{
					accountId: auth.accountId,
					filter: this.filterFor(folders, [{ notKeyword: '$seen' }, { after }]),
					sort: [{ property: 'receivedAt', isAscending: false }],
					limit: 20
				},
				'q'
			],
			[
				'Email/get',
				{
					accountId: auth.accountId,
					'#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' },
					properties: ['id', 'from', 'subject', 'receivedAt']
				},
				'g'
			]
		]);
		const list = (res.methodResponses[1][1] as { list?: Email[] }).list ?? [];
		const fresh = list.filter((e) => !this.notified.includes(e.id));
		if (fresh.length === 0) return;
		this.remember(fresh.map((e) => e.id));
		const newest = fresh.reduce((max, e) => (e.receivedAt > max ? e.receivedAt : max), this.since);
		this.since = newest;

		const { account, userId, multiAccount } = this.target;
		// With several linked accounts the app opens on whichever was used
		// last, so a message link could land in the wrong one.
		const urlFor = (id: string) => (multiAccount ? '/inbox' : `/email/${encodeURIComponent(id)}`);
		const suffix = multiAccount ? `\n${account.email}` : '';

		const payloads: PushPayload[] =
			fresh.length <= MAX_SEPARATE
				? fresh.map((e) => ({
						title: senderOf(e),
						body: (e.subject?.trim() || '(no subject)') + suffix,
						tag: `zajel-mail-${e.id}`,
						url: urlFor(e.id)
					}))
				: [
						{
							title: `${fresh.length} new messages`,
							body: [...new Set(fresh.map(senderOf))].slice(0, 4).join(', ') + suffix,
							tag: `zajel-mail-${account.id}`,
							url: '/inbox'
						}
					];
		for (const payload of payloads.reverse()) await sendPushToUser(userId, account.email, payload);
	}
}

function reminderWhen(minutesBefore: number): string {
	if (minutesBefore <= 0) return 'now';
	if (minutesBefore < 60) return `in ${minutesBefore} min`;
	if (minutesBefore < 1440) {
		const hours = Math.round(minutesBefore / 60);
		return `in ${hours} hour${hours === 1 ? '' : 's'}`;
	}
	const days = Math.round(minutesBefore / 1440);
	return days === 1 ? 'tomorrow' : `in ${days} days`;
}

interface WorkerState {
	watchers: Map<string, MailWatcher>;
	reminderTimers: Map<string, ReturnType<typeof setTimeout>>;
	sentReminders: Map<string, number>;
	reconciling: boolean;
}

// On globalThis, so a dev-server reload doesn't start a second set of
// streams (restart the dev server after changing this file).
const WORKER_KEY = Symbol.for('zajel.pushWorker');

function state(): WorkerState | undefined {
	return (globalThis as Record<symbol, WorkerState | undefined>)[WORKER_KEY];
}

/** Start or stop mail watchers to match who wants notifications now. */
export function refreshPushWatchers(): void {
	const s = state();
	if (!s || s.reconciling) return;
	s.reconciling = true;
	try {
		const desired = desiredTargets();
		for (const [id, watcher] of s.watchers) {
			const next = desired.get(id);
			if (!next || next.multiAccount !== watcher.target.multiAccount) {
				watcher.stop();
				s.watchers.delete(id);
			} else {
				// Keep the freshest row (credentials, needs_reauth).
				watcher.target.account = next.account;
			}
		}
		for (const [id, target] of desired) {
			if (s.watchers.has(id)) continue;
			const watcher = new MailWatcher(target);
			s.watchers.set(id, watcher);
			watcher.start();
		}
	} catch (err) {
		console.error('[push] reconcile failed', err);
	} finally {
		s.reconciling = false;
	}
}

async function pollReminders(): Promise<void> {
	const s = state();
	if (!s) return;
	const now = Date.now();
	for (const [key, at] of s.sentReminders) {
		if (now - at > SENT_REMINDER_TTL_MS) s.sentReminders.delete(key);
	}
	for (const { account, userId } of desiredTargets().values()) {
		const prefs = wantsNotifications(userId);
		if (!prefs || prefs.notify_event_reminders === 'off') continue;
		let auth: AuthState;
		try {
			auth = authStateForAccount(account);
		} catch {
			continue;
		}
		let items;
		try {
			items = await upcomingReminders(auth, account.email, REMINDER_HORIZON_MS);
		} catch {
			// No calendar on this account, or the server is away — next poll.
			continue;
		}
		for (const item of items) {
			const key = `${account.id}:${item.key}`;
			if (s.sentReminders.has(key) || s.reminderTimers.has(key)) continue;
			const timer = setTimeout(() => {
				s.reminderTimers.delete(key);
				s.sentReminders.set(key, Date.now());
				const current = wantsNotifications(userId);
				if (!current || current.notify_event_reminders === 'off') return;
				void sendPushToUser(userId, account.email, {
					title: item.title,
					body: `Starts ${reminderWhen(item.minutesBefore)}`,
					// The open app uses the same tag, so a device that gets both
					// shows one.
					tag: `ameera-cal-reminder-${item.key}`,
					url: '/calendar'
				});
			}, Math.max(0, item.fireAt - Date.now()));
			timer.unref?.();
			s.reminderTimers.set(key, timer);
		}
	}
}

export function startPushWorker(): void {
	if (state()) return;
	(globalThis as Record<symbol, WorkerState>)[WORKER_KEY] = {
		watchers: new Map(),
		reminderTimers: new Map(),
		sentReminders: new Map(),
		reconciling: false
	};
	refreshPushWatchers();
	void pollReminders();
	setInterval(refreshPushWatchers, RECONCILE_MS).unref?.();
	setInterval(() => void pollReminders(), REMINDER_POLL_MS).unref?.();
}
