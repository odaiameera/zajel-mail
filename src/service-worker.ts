/// <reference types="@sveltejs/kit" />
/// <reference lib="webworker" />

// SvelteKit builds and auto-registers this file. It powers PWA installability
// and instant launches by precaching the app *shell* (hashed JS/CSS/fonts/
// icons) — it deliberately never caches mail: API responses and page
// navigations always go to the network, so message content is never stale.
// On a failed navigation (offline) the user sees a small offline fallback.

import { build, files, version } from '$service-worker';

const sw = self as unknown as ServiceWorkerGlobalScope;

const CACHE = `ameera-shell-${version}`;
const OFFLINE_URL = '/offline.html';

// Sender/company avatars, cached locally per browser so repeat loads are
// instant. Unversioned name on purpose: avatars are immutable per sender and
// the server is the source of truth, so this cache should survive app
// deploys instead of being wiped each time the shell version bumps. A fresh
// browser simply rebuilds it from the (already-warm) server cache.
const AVATAR_CACHE = 'ameera-avatars-v1';
const AVATAR_PATH = '/api/avatar';
const AVATAR_MAX_ENTRIES = 600;

// Immutable, content-hashed app-shell assets. `files` (static/) includes the
// manifest, icons, robots.txt, and our offline fallback page.
const PRECACHE = [...build, ...files];
const PRECACHE_SET = new Set(PRECACHE);

sw.addEventListener('install', (event) => {
	event.waitUntil(
		(async () => {
			const cache = await caches.open(CACHE);
			await cache.addAll(PRECACHE);
			// NOTE: deliberately NO skipWaiting(). Forcing activation while a
			// navigation is in flight makes the browser re-issue that
			// navigation under the new worker — which shows up as the page
			// refreshing twice. In dev the SW re-installs on every load, so
			// skipWaiting() turned every manual refresh into a double refresh.
			// A new worker now waits for the standard lifecycle (all tabs
			// closed) before taking over, which is fine: the shell is tiny and
			// navigations are network-first anyway.
		})()
	);
});

sw.addEventListener('activate', (event) => {
	event.waitUntil(
		(async () => {
			// Drop superseded shell caches, but keep the (unversioned) avatar
			// cache so it persists across deploys. No clients.claim() — see the
			// skipWaiting note above; we let the worker take control through the
			// normal lifecycle rather than seizing in-flight clients.
			const keep = new Set([CACHE, AVATAR_CACHE]);
			for (const key of await caches.keys()) {
				if (!keep.has(key)) await caches.delete(key);
			}
		})()
	);
});

sw.addEventListener('fetch', (event) => {
	const { request } = event;
	if (request.method !== 'GET') return;

	const url = new URL(request.url);
	if (url.origin !== sw.location.origin) return;

	// 0) Sender avatars: cache-first in their own bucket. Each avatar is
	//    keyed by its ?email= URL and is effectively immutable, so a cache hit
	//    is always correct. Only 200s are cached — a 204 "no avatar" stays
	//    uncached so it can fill in once the server resolves it.
	if (url.pathname === AVATAR_PATH) {
		event.respondWith(avatarCacheFirst(request));
		return;
	}

	// 1) App-shell assets: cache-first. They're content-hashed, so a cache hit
	//    is always correct and a new build produces new URLs.
	if (PRECACHE_SET.has(url.pathname)) {
		event.respondWith(
			(async () => {
				const cached = await caches.match(request);
				return cached ?? fetch(request);
			})()
		);
		return;
	}

	// 2) Page navigations: network-first so mail is always live. Fall back to
	//    the cached offline page only when the network is unreachable.
	if (request.mode === 'navigate') {
		event.respondWith(
			(async () => {
				try {
					return await fetch(request);
				} catch {
					const cache = await caches.open(CACHE);
					const offline = await cache.match(OFFLINE_URL);
					return (
						offline ??
						new Response('Offline', { status: 503, statusText: 'Offline' })
					);
				}
			})()
		);
		return;
	}

	// 3) Everything else (API/JMAP/mail data, SSE, uploads): leave untouched so
	//    it always hits the network and is never cached.
});

// Web Push (see $lib/server/push): every message becomes a notification.
// Safari revokes a subscription whose pushes show nothing, so there is no
// "app is open, stay quiet" path here; the open app instead leaves new-mail
// notifications to push on a device that has a subscription.
sw.addEventListener('push', (event) => {
	let data: { title?: string; body?: string; tag?: string; url?: string } = {};
	try {
		data = event.data?.json() ?? {};
	} catch {
		data = { body: event.data?.text() };
	}
	event.waitUntil(
		sw.registration.showNotification(data.title || 'Zajel Mail', {
			body: data.body,
			tag: data.tag,
			icon: '/icon-192.png',
			data: { url: data.url || '/inbox' }
		})
	);
});

// Open the app where the notification points: an open window if there is
// one, else a new one.
sw.addEventListener('notificationclick', (event) => {
	event.notification.close();
	const target = new URL(event.notification.data?.url || '/inbox', sw.location.origin);
	if (target.origin !== sw.location.origin) return;
	event.waitUntil(
		(async () => {
			const windows = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
			const open = windows.find((w) => new URL(w.url).origin === sw.location.origin);
			if (open) {
				await open.focus();
				await open.navigate(target.href).catch(() => {});
				return;
			}
			await sw.clients.openWindow(target.href);
		})()
	);
});

// The browser replaced the subscription (keys rotated, or it expired): hand
// the server the new one so pushes keep arriving.
sw.addEventListener('pushsubscriptionchange', (event) => {
	const change = event as Event & {
		oldSubscription?: PushSubscription | null;
		newSubscription?: PushSubscription | null;
		waitUntil(p: Promise<unknown>): void;
	};
	change.waitUntil(
		(async () => {
			let sub = change.newSubscription ?? null;
			if (!sub) {
				const res = await fetch('/api/push');
				if (!res.ok) return;
				const { publicKey } = (await res.json()) as { publicKey: string };
				const raw = atob(publicKey.replace(/-/g, '+').replace(/_/g, '/'));
				sub = await sw.registration.pushManager.subscribe({
					userVisibleOnly: true,
					applicationServerKey: Uint8Array.from(raw, (c) => c.charCodeAt(0))
				});
			}
			if (change.oldSubscription) {
				await fetch('/api/push', {
					method: 'DELETE',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ endpoint: change.oldSubscription.endpoint })
				}).catch(() => {});
			}
			await fetch('/api/push', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(sub.toJSON())
			});
		})()
	);
});

async function avatarCacheFirst(request: Request): Promise<Response> {
	const cache = await caches.open(AVATAR_CACHE);
	const hit = await cache.match(request);
	if (hit) return hit;
	try {
		const res = await fetch(request);
		if (res.status === 200) {
			await cache.put(request, res.clone());
			void trimAvatarCache(cache);
		}
		return res;
	} catch {
		// Offline and not cached — let the <img> fall back to initials.
		return new Response(null, { status: 504 });
	}
}

// Crude FIFO bound so a long-lived browser doesn't grow the avatar cache
// without limit. Cache.keys() preserves insertion order, so deleting from the
// front drops the oldest entries.
async function trimAvatarCache(cache: Cache): Promise<void> {
	const keys = await cache.keys();
	if (keys.length <= AVATAR_MAX_ENTRIES) return;
	for (const req of keys.slice(0, keys.length - AVATAR_MAX_ENTRIES)) {
		await cache.delete(req);
	}
}
