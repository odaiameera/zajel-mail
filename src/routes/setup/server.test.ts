import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ createAppUser: vi.fn(), createAppSession: vi.fn(() => 'session-1') }));
vi.mock('$env/dynamic/private', () => ({ env: {} }));
vi.mock('$lib/server/auth/user', () => ({ createAppUser: mocks.createAppUser, hasAppUser: () => false }));
vi.mock('$lib/server/auth/app-session', () => ({ createAppSession: mocks.createAppSession }));
vi.mock('$lib/server/auth/accounts', () => ({
	describeLinkError: vi.fn(),
	linkAccount: vi.fn(),
	normalizeServerUrl: (s: string) => s
}));

import { actions } from './+page.server';

async function create(fields: Record<string, string>) {
	const body = new FormData();
	for (const [key, value] of Object.entries(fields)) body.set(key, value);
	const cookies = { set: vi.fn() };
	const result = await actions.create!({
		request: new Request('http://localhost/setup?/create', { method: 'POST', body }),
		cookies,
		getClientAddress: () => '203.0.113.7'
	} as unknown as Parameters<typeof actions.create>[0]);
	return { result: result as { status: number; data: Record<string, unknown> }, cookies };
}

describe('first-run setup', () => {
	it('tells the loser of a race that setup is already complete, without a session', async () => {
		mocks.createAppUser.mockResolvedValue(undefined);
		const { result, cookies } = await create({ email: 'me@example.test', password: 'password-one', confirm: 'password-one' });
		expect(result.status).toBe(409);
		expect(result.data.error).toMatch(/already complete/);
		expect(mocks.createAppSession).not.toHaveBeenCalled();
		expect(cookies.set).not.toHaveBeenCalled();
	});
});
