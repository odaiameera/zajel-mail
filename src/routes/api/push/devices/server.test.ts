import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock('$lib/server/db/queries/push', () => ({ listPushSubscriptions: mocks.list }));

import { GET } from './+server';

const row = (over: Record<string, unknown>) => ({
	endpoint: 'https://web.push.apple.com/secret-endpoint',
	user_id: 'u1',
	session_id: 's-other',
	p256dh: 'p256dh-key',
	auth: 'auth-key',
	user_agent: null,
	created_at: '2026-11-01 10:00:00',
	last_sent_at: null,
	...over
});

describe('GET /api/push/devices', () => {
	it('requires a sign-in', async () => {
		expect((await GET({ locals: {} } as never)).status).toBe(401);
		expect(mocks.list).not.toHaveBeenCalled();
	});

	it('names each device, puts this one first and keeps endpoints and keys to itself', async () => {
		mocks.list.mockReturnValue([
			row({
				user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
				last_sent_at: '2026-11-02 09:00:00'
			}),
			row({
				session_id: 's-me',
				user_agent:
					'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1'
			})
		]);
		const res = await GET({ locals: { user: { id: 'u1' }, sessionId: 's-me' } } as never);
		expect(res.status).toBe(200);
		const body = await res.text();
		expect(JSON.parse(body).devices).toEqual([
			{ label: 'Safari on iOS', current: true, createdAt: '2026-11-01 10:00:00', lastSentAt: null },
			{ label: 'Chrome on Windows', current: false, createdAt: '2026-11-01 10:00:00', lastSentAt: '2026-11-02 09:00:00' }
		]);
		expect(body).not.toContain('secret-endpoint');
		expect(body).not.toContain('-key');
		expect(mocks.list).toHaveBeenCalledWith('u1');
	});
});
