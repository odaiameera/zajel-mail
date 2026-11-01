import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	verifyUserPassword: vi.fn(),
	isLockedOut: vi.fn(),
	recordFailure: vi.fn(),
	recordSuccess: vi.fn()
}));
vi.mock('$lib/server/auth/user', () => ({ verifyUserPassword: mocks.verifyUserPassword }));
vi.mock('$lib/server/auth/app-session', () => ({ createAppSession: vi.fn() }));
vi.mock('$lib/server/auth/rate-limit', () => ({
	isLockedOut: mocks.isLockedOut,
	recordFailure: mocks.recordFailure,
	recordSuccess: mocks.recordSuccess
}));

import { actions } from './+page.server';

function login(email: string, password = 'secret') {
	const body = new FormData();
	body.set('email', email);
	body.set('password', password);
	return actions.default({
		request: new Request('http://localhost/login', { method: 'POST', body }),
		cookies: { set: vi.fn() },
		getClientAddress: () => '203.0.113.7'
	} as unknown as Parameters<typeof actions.default>[0]) as Promise<{ status: number; data: Record<string, unknown> }>;
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.isLockedOut.mockReturnValue(false);
	mocks.verifyUserPassword.mockReturnValue(undefined);
});

describe('login', () => {
	it('counts a wrong password against the email and IP', async () => {
		const result = await login('me@example.test');
		expect(result.status).toBe(401);
		expect(mocks.recordFailure).toHaveBeenCalledWith('me@example.test', '203.0.113.7');
	});

	it('turns away an email longer than any address, before checking anything', async () => {
		const result = await login('x'.repeat(255));
		expect(result.status).toBe(400);
		expect(result.data.email).toBeUndefined();
		expect(mocks.verifyUserPassword).not.toHaveBeenCalled();
		expect(mocks.recordFailure).not.toHaveBeenCalled();
	});
});
