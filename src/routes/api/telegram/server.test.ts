import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	mode: 'live' as 'live' | 'mock' | 'off',
	jevOn: new Set<string>(),
	reauth: new Set<string>()
}));
vi.mock('$lib/server/telegram/bot', () => ({
	botUsername: vi.fn(),
	telegramConfigured: () => true,
	TelegramError: class extends Error {}
}));
vi.mock('$lib/server/telegram/notifier', () => ({ sendTestAlert: vi.fn() }));
vi.mock('$lib/server/telegram/store', () => ({
	createLinkCode: vi.fn(),
	getLink: () => ({ userId: 'u1', chatId: '1', username: 'me', urgent: true, paused: false }),
	setLinkFlags: vi.fn(),
	unlink: vi.fn()
}));
vi.mock('$lib/server/auth/accounts', () => ({
	listAccounts: () =>
		[
			{ id: 'a1', email: 'me@example.test' },
			{ id: 'a2', email: 'work@example.test' }
		].map((a) => ({ ...a, needs_reauth: mocks.reauth.has(a.id) ? 1 : 0 }))
}));
vi.mock('$lib/server/jev/client', () => ({ jevMode: () => mocks.mode }));
vi.mock('$lib/server/db/queries/jev-settings', () => ({
	getJevSettings: (id: string) => ({ jevEnabled: mocks.jevOn.has(id) })
}));

import { GET } from './+server';

async function status() {
	const res = await GET({ locals: { user: { id: 'u1' } } } as unknown as Parameters<typeof GET>[0]);
	return res.json();
}

beforeEach(() => {
	mocks.mode = 'live';
	mocks.jevOn = new Set(['a1']);
	mocks.reauth = new Set();
});

describe('GET /api/telegram', () => {
	it('says which accounts Jev reads, since only those can raise urgent alerts', async () => {
		expect((await status()).accounts).toEqual([
			{ email: 'me@example.test', blocked: null },
			{ email: 'work@example.test', blocked: 'account' }
		]);
	});

	it('counts an account whose password stopped working as unread: Jev skips it', async () => {
		mocks.reauth = new Set(['a1']);
		expect((await status()).accounts[0]).toEqual({ email: 'me@example.test', blocked: 'sign-in' });
	});

	it('reads none while Jev is off on the server, and reads in mock mode', async () => {
		mocks.mode = 'off';
		expect((await status()).accounts.map((a: { blocked: string }) => a.blocked)).toEqual(['server', 'server']);
		mocks.mode = 'mock';
		expect((await status()).accounts[0].blocked).toBeNull();
	});

	it('leaves the stored switch as it is, and needs a signed-in user', async () => {
		expect((await status()).urgent).toBe(true);
		await expect(GET({ locals: {} } as unknown as Parameters<typeof GET>[0])).rejects.toMatchObject({ status: 401 });
	});
});
