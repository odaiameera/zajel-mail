import { browser } from '$app/environment';

/**
 * System notifications from the browser side.
 *
 * Mobile browsers have no `new Notification()`: Chrome on Android throws,
 * and Safari on iOS only has the Notification API at all in a Home Screen
 * app, where it shows notifications through the service worker. So every
 * notification goes through the service worker registration, with the
 * constructor only as a fallback for a desktop browser without one.
 *
 * Push (a subscription per device, see /api/push) is what reaches a phone
 * while the app is closed; this module subscribes and unsubscribes it.
 */

export type NotifySupport = 'supported' | 'needs-home-screen' | 'unsupported';

function isIos(): boolean {
	return (
		/iPad|iPhone|iPod/.test(navigator.userAgent) ||
		// iPadOS asks for desktop sites and reports itself as a Mac.
		(navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
	);
}

function isStandalone(): boolean {
	return (
		window.matchMedia?.('(display-mode: standalone)').matches ||
		(navigator as Navigator & { standalone?: boolean }).standalone === true
	);
}

export function notificationSupport(): NotifySupport {
	if (!browser) return 'unsupported';
	if (typeof Notification !== 'undefined') return 'supported';
	return isIos() && !isStandalone() ? 'needs-home-screen' : 'unsupported';
}

export function canNotify(): boolean {
	return typeof Notification !== 'undefined' && Notification.permission === 'granted';
}

function pushAvailable(): boolean {
	return browser && 'serviceWorker' in navigator && 'PushManager' in window;
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
	if (!browser || !('serviceWorker' in navigator)) return null;
	// `ready` never settles without a worker (dev without one, or blocked).
	const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000));
	return Promise.race([navigator.serviceWorker.ready, timeout]);
}

export async function showNotification(
	title: string,
	options: { body?: string; tag?: string; url?: string } = {}
): Promise<void> {
	if (!canNotify()) return;
	const { url, ...rest } = options;
	const reg = await registration();
	if (reg) {
		try {
			await reg.showNotification(title, { ...rest, icon: '/icon-192.png', data: { url: url ?? '/inbox' } });
			return;
		} catch {
			// Fall through to the constructor.
		}
	}
	try {
		new Notification(title, rest);
	} catch {
		// No way to show one here.
	}
}

/** This device's push subscription, if it has one. */
export async function currentPushSubscription(): Promise<PushSubscription | null> {
	if (!pushAvailable()) return null;
	const reg = await registration();
	return (await reg?.pushManager.getSubscription()) ?? null;
}

/**
 * Subscribe this device (or refresh its subscription with the server).
 * Needs notification permission already granted. Returns false when push
 * isn't available here; notifications then only show while the app is open.
 */
export async function subscribePush(): Promise<boolean> {
	if (!pushAvailable() || !canNotify()) return false;
	const reg = await registration();
	if (!reg) return false;
	const keyRes = await fetch('/api/push');
	if (!keyRes.ok) return false;
	const { publicKey } = (await keyRes.json()) as { publicKey: string };

	let sub = await reg.pushManager.getSubscription();
	// A subscription made with another server key (the key was replaced)
	// can't receive anything any more.
	if (sub) {
		const current = sub.options.applicationServerKey;
		if (current && base64Url(current) !== publicKey) {
			await sub.unsubscribe().catch(() => {});
			sub = null;
		}
	}
	sub ??= await reg.pushManager.subscribe({
		userVisibleOnly: true,
		applicationServerKey: fromBase64Url(publicKey)
	});

	const res = await fetch('/api/push', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(sub.toJSON())
	});
	return res.ok;
}

export async function unsubscribePush(): Promise<void> {
	const sub = await currentPushSubscription().catch(() => null);
	if (!sub) return;
	await fetch('/api/push', {
		method: 'DELETE',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ endpoint: sub.endpoint })
	}).catch(() => {});
	await sub.unsubscribe().catch(() => {});
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
	const base64 = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

function base64Url(buffer: ArrayBuffer): string {
	let binary = '';
	for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
