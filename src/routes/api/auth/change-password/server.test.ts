import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isHttpError } from '@sveltejs/kit';

const mocks = vi.hoisted(() => ({
	changePassword: vi.fn(),
	revokeOtherSessions: vi.fn(),
	hasSecondFactor: vi.fn(),
	isLockedOut: vi.fn(),
	recordFailure: vi.fn(),
	recordSuccess: vi.fn()
}));
vi.mock('$lib/server/auth/user', () => ({ changePassword: mocks.changePassword }));
vi.mock('$lib/server/auth/app-session', () => ({ revokeOtherSessions: mocks.revokeOtherSessions }));
vi.mock('$lib/server/auth/mfa', () => ({ hasSecondFactor: mocks.hasSecondFactor }));
vi.mock('$lib/server/auth/rate-limit', () => ({
	isLockedOut: mocks.isLockedOut,
	recordFailure: mocks.recordFailure,
	recordSuccess: mocks.recordSuccess
}));

import { POST } from './+server';

const user = { id: 'u1', email: 'me@example.test' };

async function change(body: Record<string, unknown>, sessionVerifiedAt?: number) {
	try {
		const res = await POST({
			locals: { user, sessionId: 's1', sessionVerifiedAt },
			request: new Request('http://localhost/api/auth/change-password', {
				method: 'POST',
				body: JSON.stringify(body)
			}),
			getClientAddress: () => '203.0.113.7'
		} as unknown as Parameters<typeof POST>[0]);
		return res.status;
	} catch (thrown) {
		if (isHttpError(thrown)) return thrown.status;
		throw thrown;
	}
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.isLockedOut.mockReturnValue(false);
	mocks.hasSecondFactor.mockReturnValue(false);
});

describe('POST /api/auth/change-password', () => {
	it('changes the password and signs out the other devices', async () => {
		mocks.changePassword.mockResolvedValue(true);
		expect(await change({ current: 'old-secret', next: 'new-secret-1' })).toBe(200);
		expect(mocks.revokeOtherSessions).toHaveBeenCalledWith('u1', 's1');
		expect(mocks.recordSuccess).toHaveBeenCalledWith('step-up:u1', '203.0.113.7');
	});

	it('counts a wrong current password against the login, like a wrong step-up answer', async () => {
		mocks.changePassword.mockResolvedValue(false);
		expect(await change({ current: 'guess', next: 'new-secret-1' })).toBe(403);
		expect(mocks.recordFailure).toHaveBeenCalledWith('step-up:u1', '203.0.113.7');
		expect(mocks.revokeOtherSessions).not.toHaveBeenCalled();
	});

	it('refuses to check anything once the login is locked out', async () => {
		mocks.isLockedOut.mockReturnValue(true);
		expect(await change({ current: 'guess', next: 'new-secret-1' })).toBe(429);
		expect(mocks.changePassword).not.toHaveBeenCalled();
	});

	it('asks for the second factor first when one is set up', async () => {
		mocks.hasSecondFactor.mockReturnValue(true);
		expect(await change({ current: 'old-secret', next: 'new-secret-1' })).toBe(403);
		expect(mocks.changePassword).not.toHaveBeenCalled();

		mocks.changePassword.mockResolvedValue(true);
		expect(await change({ current: 'old-secret', next: 'new-secret-1' }, Date.now())).toBe(200);
	});
});
