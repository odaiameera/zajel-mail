import { writable, get } from 'svelte/store';
import { invalidateAll } from '$app/navigation';
import { browser } from '$app/environment';

/**
 * Drives the live `EventSource` connection to `/api/events` (which proxies
 * Stalwart's `/jmap/eventsource/`). Stalwart pushes a `StateChange` payload
 * each time a watched type changes; the store debounces those changes into
 * a single `invalidateAll()` so every load function re-runs and the UI
 * reflects the new server state without polling.
 */
export interface RealtimeState {
	connected: boolean;
	lastEventAt: number | null;
	reconnectAttempts: number;
}

interface StateTokens {
	Email?: string;
	Mailbox?: string;
	EmailDelivery?: string;
}

// Start optimistically connected so opening the app doesn't flash
// "Reconnecting" during the ~sub-second SSE handshake (and hides
// transient drops that resolve within the grace window below).
const INITIAL: RealtimeState = {
	connected: true,
	lastEventAt: null,
	reconnectAttempts: 0
};

const INVALIDATE_DEBOUNCE_MS = 300;
const MAX_RECONNECT_DELAY_MS = 30_000;
const DISCONNECT_GRACE_MS = 2_000;
// Shown again after this long hidden, the app refreshes: a phone can keep
// a stream that died in the background looking open.
const HIDDEN_REFRESH_MS = 60_000;

function createRealtimeStore() {
	const { subscribe, set, update } = writable<RealtimeState>(INITIAL);

	let source: EventSource | null = null;
	const tokens: StateTokens = {};
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	let changeDebounceTimer: ReturnType<typeof setTimeout> | null = null;
	let disconnectTimer: ReturnType<typeof setTimeout> | null = null;
	// Stalwart sends nothing when a stream opens, only on the next change, so
	// mail that arrived while the stream was down would stay unseen. Every
	// open after the first refreshes for that reason.
	let opened = false;
	let hiddenAt: number | null = null;

	function onVisibilityChange() {
		if (document.visibilityState === 'hidden') {
			hiddenAt = Date.now();
			return;
		}
		if (hiddenAt !== null && Date.now() - hiddenAt > HIDDEN_REFRESH_MS) scheduleInvalidation();
		hiddenAt = null;
	}

	function scheduleInvalidation() {
		if (changeDebounceTimer) clearTimeout(changeDebounceTimer);
		changeDebounceTimer = setTimeout(() => {
			changeDebounceTimer = null;
			invalidateAll();
		}, INVALIDATE_DEBOUNCE_MS);
	}

	function handleStateChange(payload: unknown): void {
		// Stalwart payload shape:
		// { '@type': 'StateChange', changed: { <accountId>: { Email: '<token>', Mailbox: '<token>', … } } }
		if (!payload || typeof payload !== 'object') return;
		const data = payload as { '@type'?: string; changed?: Record<string, Record<string, string>> };
		if (data['@type'] !== 'StateChange' || !data.changed) return;

		const accounts = Object.values(data.changed);
		if (accounts.length === 0) return;
		const account = accounts[0];

		let hasChange = false;
		for (const [key, value] of Object.entries(account)) {
			const tokenKey = key as keyof StateTokens;
			if (tokens[tokenKey] !== value) {
				tokens[tokenKey] = value;
				hasChange = true;
			}
		}

		if (hasChange) {
			update((s) => ({ ...s, lastEventAt: Date.now() }));
			scheduleInvalidation();
		}
	}

	function connect(): void {
		if (!browser) return;
		if (source) source.close();

		// Stalwart doesn't replay state changes that arrived while the SSE
		// was down (we don't send Last-Event-ID), so any tokens cached from
		// the previous connection are stale. Wipe them so the first
		// `state` event after the new open is always treated as a change
		// and triggers `invalidateAll()`.
		for (const key of Object.keys(tokens) as (keyof StateTokens)[]) {
			delete tokens[key];
		}

		document.removeEventListener('visibilitychange', onVisibilityChange);
		document.addEventListener('visibilitychange', onVisibilityChange);

		const startedAt = Date.now();
		console.log(`[realtime] connecting at ${new Date(startedAt).toISOString()}`);
		source = new EventSource('/api/events');

		source.onopen = () => {
			const ms = Date.now() - startedAt;
			console.log(`[realtime] open after ${ms}ms`);
			if (disconnectTimer) {
				clearTimeout(disconnectTimer);
				disconnectTimer = null;
			}
			update((s) => ({ ...s, connected: true, reconnectAttempts: 0 }));
			if (opened) scheduleInvalidation();
			opened = true;
		};

		// Stalwart emits `event: state` per RFC 8620 §7.3, so listen for
		// the named event instead of the default `message`. Keep-alives
		// arrive as SSE comment lines (`: ping`) and aren't dispatched
		// as events at all, so no separate handler is needed.
		source.addEventListener('state', (ev: MessageEvent) => {
			if (!ev.data) return;
			try {
				handleStateChange(JSON.parse(ev.data));
			} catch {
				// ignore malformed events
			}
		});

		source.onerror = () => {
			const livedMs = Date.now() - startedAt;
			const readyState = source?.readyState;
			console.log(
				`[realtime] error after ${(livedMs / 1000).toFixed(1)}s readyState=${readyState}`
			);
			// Brief drops (server-side SSE recycle, tab wake-up) reopen within
			// a second or two. Only flip the UI to "Reconnecting" if we haven't
			// re-opened by then, so transient blips don't flash the indicator.
			if (!disconnectTimer) {
				disconnectTimer = setTimeout(() => {
					disconnectTimer = null;
					update((s) => ({ ...s, connected: false }));
				}, DISCONNECT_GRACE_MS);
			}
			// EventSource auto-reconnects on its own when readyState === 0
			// (CONNECTING). Scheduling our own reconnect in that window
			// races the native retry — when our timer fires, `connect()`
			// closes the freshly-reopened source. Only step in when the
			// browser has given up (readyState === 2 / CLOSED).
			if (source?.readyState === 2) {
				scheduleReconnect();
			}
		};
	}

	function scheduleReconnect(): void {
		if (reconnectTimer) return;
		const state = get({ subscribe });
		// 1s, 2s, 4s, 8s, 16s, then 30s ceiling.
		const delay = Math.min(1000 * Math.pow(2, state.reconnectAttempts), MAX_RECONNECT_DELAY_MS);
		reconnectTimer = setTimeout(() => {
			reconnectTimer = null;
			update((s) => ({ ...s, reconnectAttempts: s.reconnectAttempts + 1 }));
			connect();
		}, delay);
	}

	function disconnect(): void {
		if (source) {
			source.close();
			source = null;
		}
		if (browser) document.removeEventListener('visibilitychange', onVisibilityChange);
		opened = false;
		hiddenAt = null;
		if (reconnectTimer) {
			clearTimeout(reconnectTimer);
			reconnectTimer = null;
		}
		if (changeDebounceTimer) {
			clearTimeout(changeDebounceTimer);
			changeDebounceTimer = null;
		}
		if (disconnectTimer) {
			clearTimeout(disconnectTimer);
			disconnectTimer = null;
		}
		set(INITIAL);
	}

	return {
		subscribe,
		connect,
		disconnect
	};
}

export const realtime = createRealtimeStore();
