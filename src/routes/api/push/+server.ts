import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { vapidKeys } from '$lib/server/push/send';
import { refreshPushWatchers } from '$lib/server/push/worker';
import { deletePushSubscription, savePushSubscription } from '$lib/server/db/queries/push';

/**
 * This device's Web Push subscription. GET hands the browser the server's
 * public key to subscribe with; POST stores the subscription it made; DELETE
 * forgets it (notifications turned off here, or the browser unsubscribed).
 */

// The server POSTs to whatever endpoint is stored, so only the browsers'
// own push services are accepted — never an arbitrary URL.
const PUSH_HOSTS = [
	'push.apple.com', // Safari, including Home Screen apps on iOS
	'fcm.googleapis.com', // Chrome, Edge on Android, Brave, Opera
	'android.googleapis.com',
	'push.services.mozilla.com', // Firefox
	'notify.windows.com' // Edge on Windows
];

function isPushEndpoint(value: unknown): value is string {
	if (typeof value !== 'string' || value.length > 2048) return false;
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return false;
	}
	if (url.protocol !== 'https:' || url.port !== '') return false;
	const host = url.hostname.toLowerCase();
	return PUSH_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

const KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}={0,2}$/;

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	return json({ publicKey: vapidKeys().publicKey });
};

export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.user || !locals.sessionId) return json({ error: 'Unauthorized' }, { status: 401 });
	const body = (await request.json().catch(() => null)) as {
		endpoint?: unknown;
		keys?: { p256dh?: unknown; auth?: unknown };
	} | null;
	const endpoint = body?.endpoint;
	const p256dh = body?.keys?.p256dh;
	const auth = body?.keys?.auth;
	if (!isPushEndpoint(endpoint)) {
		return json({ error: 'Unsupported push service' }, { status: 400 });
	}
	if (typeof p256dh !== 'string' || !KEY_PATTERN.test(p256dh) || typeof auth !== 'string' || !KEY_PATTERN.test(auth)) {
		return json({ error: 'Invalid subscription keys' }, { status: 400 });
	}
	const userAgent = request.headers.get('user-agent')?.slice(0, 300) ?? null;
	savePushSubscription(locals.user.id, locals.sessionId, { endpoint, p256dh, auth }, userAgent);
	refreshPushWatchers();
	return json({ success: true });
};

export const DELETE: RequestHandler = async ({ locals, request }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	const body = (await request.json().catch(() => null)) as { endpoint?: unknown } | null;
	if (typeof body?.endpoint !== 'string') return json({ error: 'endpoint is required' }, { status: 400 });
	deletePushSubscription(locals.user.id, body.endpoint);
	refreshPushWatchers();
	return json({ success: true });
};
