import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	listAccounts: vi.fn(),
	updateJevSettings: vi.fn(),
	jevMode: vi.fn()
}));

vi.mock('$lib/server/auth/accounts', () => ({ listAccounts: mocks.listAccounts, listAllMailAccounts: () => [] }));
vi.mock('$lib/server/db/queries/jev-settings', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/db/queries/jev-settings')>()),
	updateJevSettings: mocks.updateJevSettings
}));
vi.mock('$lib/server/jev/client', () => ({ jevMode: mocks.jevMode }));

import { POST } from './+server';

// `null` for signed out: `undefined` would pick up the default.
function call(body: unknown, user: { id: string } | null = { id: 'user-1' }) {
	return POST({
		request: new Request('http://localhost/api/jev/settings', {
			method: 'POST',
			body: JSON.stringify(body)
		}),
		locals: { user: user ?? undefined }
	} as unknown as Parameters<typeof POST>[0]);
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.listAccounts.mockReturnValue([{ id: 'acct-1' }]);
	mocks.jevMode.mockReturnValue('live');
	mocks.updateJevSettings.mockImplementation((_id: string, patch: object) => ({
		inboxTabs: false,
		jevEnabled: false,
		jevSince: null,
		...patch
	}));
});

describe('POST /api/jev/settings', () => {
	it('saves the switch for one of the login’s own accounts', async () => {
		const res = await call({ accountId: 'acct-1', inboxTabs: true });
		expect(res.status).toBe(200);
		expect(mocks.listAccounts).toHaveBeenCalledWith('user-1');
		expect(mocks.updateJevSettings).toHaveBeenCalledWith('acct-1', { inboxTabs: true });
	});

	it('saves both switches in one go', async () => {
		const res = await call({ accountId: 'acct-1', inboxTabs: false, jevEnabled: false });
		expect(res.status).toBe(200);
		expect(mocks.updateJevSettings).toHaveBeenCalledWith('acct-1', { inboxTabs: false, jevEnabled: false });
	});

	it('refuses an account that belongs to someone else', async () => {
		const res = await call({ accountId: 'acct-9', inboxTabs: true });
		expect(res.status).toBe(404);
		expect(mocks.updateJevSettings).not.toHaveBeenCalled();
	});

	it('requires booleans, and something to change', async () => {
		expect((await call({ accountId: 'acct-1', inboxTabs: 'yes' })).status).toBe(400);
		expect((await call({ accountId: 'acct-1', jevEnabled: 1 })).status).toBe(400);
		expect((await call({ accountId: 'acct-1' })).status).toBe(400);
		expect(mocks.updateJevSettings).not.toHaveBeenCalled();
	});

	it('won’t switch sorting on while Jev isn’t configured', async () => {
		mocks.jevMode.mockReturnValue('off');
		const res = await call({ accountId: 'acct-1', jevEnabled: true });
		expect(res.status).toBe(409);
		expect(mocks.updateJevSettings).not.toHaveBeenCalled();

		// Switching it off still works.
		expect((await call({ accountId: 'acct-1', jevEnabled: false })).status).toBe(200);
	});

	it('sets the spam mode, and only to a known one', async () => {
		expect((await call({ accountId: 'acct-1', spamMode: 'watch' })).status).toBe(200);
		expect(mocks.updateJevSettings).toHaveBeenCalledWith('acct-1', { spamMode: 'watch' });
		expect((await call({ accountId: 'acct-1', spamMode: 'aggressive' })).status).toBe(400);
		mocks.jevMode.mockReturnValue('off');
		expect((await call({ accountId: 'acct-1', spamMode: 'active' })).status).toBe(409);
	});

	it('requires a signed-in user', async () => {
		await expect(call({ accountId: 'acct-1', inboxTabs: true }, null)).rejects.toMatchObject({
			status: 401
		});
	});
});
