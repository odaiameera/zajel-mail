import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listPushSubscriptions } from '$lib/server/db/queries/push';
import { describeDevice } from '$lib/devices';

/**
 * The devices receiving push for this login, for Settings → Notifications:
 * one per browser that turned push on, the one made under this session
 * marked as this device, this device first. Endpoints and keys stay here.
 */
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	const devices = listPushSubscriptions(locals.user.id)
		.map((s) => ({
			label: describeDevice(s.user_agent),
			current: s.session_id === locals.sessionId,
			createdAt: s.created_at,
			lastSentAt: s.last_sent_at
		}))
		.sort((a, b) => Number(b.current) - Number(a.current) || (b.lastSentAt ?? '').localeCompare(a.lastSentAt ?? ''));
	return json({ devices });
};
