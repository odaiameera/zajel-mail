import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ setPin: vi.fn(), deletePin: vi.fn() }));

vi.mock('$lib/server/auth/accounts', () => ({ listAccounts: () => [{ id: 'acct-1' }, { id: 'acct-2' }], listAllMailAccounts: () => [] }));
vi.mock('$lib/server/db/queries/jev-learning', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/db/queries/jev-learning')>()),
	setPin: mocks.setPin,
	deletePin: mocks.deletePin
}));

import { DELETE, POST } from './+server';

function call(handler: typeof POST, body: unknown) {
	return handler({
		request: new Request('http://localhost/api/jev/pins', { method: 'POST', body: JSON.stringify(body) }),
		locals: { user: { id: 'user-1' }, activeAccountId: 'acct-1' }
	} as unknown as Parameters<typeof POST>[0]);
}

beforeEach(() => vi.clearAllMocks());

describe('/api/jev/pins', () => {
	it('pins a sender for the account in use, or another of the login’s own', async () => {
		expect((await call(POST, { sender: 'Jobs@LinkedIn.com', category: 'updates' })).status).toBe(200);
		expect(mocks.setPin).toHaveBeenCalledWith('acct-1', 'jobs@linkedin.com', 'updates');

		expect((await call(POST, { accountId: 'acct-2', sender: '@shop.example', category: 'promotions' })).status).toBe(200);
		expect(mocks.setPin).toHaveBeenLastCalledWith('acct-2', '@shop.example', 'promotions');
	});

	it('refuses other people’s accounts, bad senders and unknown tabs', async () => {
		expect((await call(POST, { accountId: 'acct-9', sender: 'a@b.example', category: 'updates' })).status).toBe(404);
		expect((await call(POST, { sender: 'not an address', category: 'updates' })).status).toBe(400);
		expect((await call(POST, { sender: 'a@b.example', category: 'social' })).status).toBe(400);
		expect(mocks.setPin).not.toHaveBeenCalled();
	});

	it('removes a pin', async () => {
		expect((await call(DELETE, { sender: '@shop.example' })).status).toBe(200);
		expect(mocks.deletePin).toHaveBeenCalledWith('acct-1', '@shop.example');
	});
});
