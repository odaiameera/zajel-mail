import webpush from 'web-push';
import { env } from '$env/dynamic/private';
import { decryptSecret, encryptSecret } from '../auth/crypto';
import {
	deleteExpiredSubscription,
	deleteEverySubscription,
	getVapidRow,
	insertVapidRow,
	listPushSubscriptions,
	markPushSent,
	replaceVapidRow
} from '../db/queries/push';

/**
 * Sending Web Push messages to every device a user turned notifications on
 * from. The service worker turns each message into a system notification
 * (see src/service-worker.ts), so the payload is exactly what it shows.
 */

export interface PushPayload {
	title: string;
	body?: string;
	/** Same tag, same notification: a newer one replaces it. */
	tag?: string;
	/** Where clicking the notification goes. */
	url?: string;
}

interface VapidKeys {
	publicKey: string;
	privateKey: string;
}

let cached: VapidKeys | null = null;

/**
 * The server's VAPID key pair, made on first use and kept in SQLite. If the
 * private key no longer decrypts (WEBMAIL_SECRET was rotated), a new pair
 * replaces it, and every subscription goes with the old one: push services
 * only accept messages signed by the key a subscription was made with.
 */
export function vapidKeys(): VapidKeys {
	if (cached) return cached;
	const row = getVapidRow();
	if (row) {
		try {
			cached = { publicKey: row.public_key, privateKey: decryptSecret(row.private_enc) };
			return cached;
		} catch {
			const fresh = webpush.generateVAPIDKeys();
			replaceVapidRow(fresh.publicKey, encryptSecret(fresh.privateKey));
			deleteEverySubscription();
			cached = fresh;
			return cached;
		}
	}
	const fresh = webpush.generateVAPIDKeys();
	const stored = insertVapidRow(fresh.publicKey, encryptSecret(fresh.privateKey));
	cached =
		stored.public_key === fresh.publicKey
			? fresh
			: { publicKey: stored.public_key, privateKey: decryptSecret(stored.private_enc) };
	return cached;
}

/**
 * The contact push services may use about this server. Apple requires a
 * mailto: or https: URL here and rejects messages without one.
 */
function vapidSubject(contactEmail: string): string {
	if (env.VAPID_SUBJECT) return env.VAPID_SUBJECT;
	if (env.ORIGIN?.startsWith('https://')) return env.ORIGIN;
	return `mailto:${contactEmail}`;
}

/** Send `payload` to each of the user's devices. Never throws. */
export async function sendPushToUser(
	userId: string,
	contactEmail: string,
	payload: PushPayload
): Promise<void> {
	const subscriptions = listPushSubscriptions(userId);
	if (subscriptions.length === 0) return;
	const { publicKey, privateKey } = vapidKeys();
	const body = JSON.stringify(payload);
	await Promise.all(
		subscriptions.map(async (sub) => {
			try {
				await webpush.sendNotification(
					{ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
					body,
					{
						vapidDetails: { subject: vapidSubject(contactEmail), publicKey, privateKey },
						// A mail notification an hour late is noise; drop it instead.
						TTL: 3600,
						urgency: 'high',
						timeout: 10_000
					}
				);
				markPushSent(sub.endpoint);
			} catch (err) {
				const status = (err as { statusCode?: number }).statusCode;
				// Unsubscribed, or the browser data was cleared.
				if (status === 404 || status === 410) deleteExpiredSubscription(sub.endpoint);
				else console.warn(`[push] send failed (${status ?? (err as Error).message})`);
			}
		})
	);
}
