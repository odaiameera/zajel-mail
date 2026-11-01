import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isHttpError } from '@sveltejs/kit';

const mocks = vi.hoisted(() => ({
	markSessionVerified: vi.fn(),
	hasSecondFactor: vi.fn(),
	verifySecondFactorCode: vi.fn(),
	verifyPasswordForUser: vi.fn(),
	verifyAuthentication: vi.fn(),
	isLockedOut: vi.fn(),
	recordFailure: vi.fn(),
	registrationOptions: vi.fn(async () => ({ challenge: 'c' }))
}));
vi.mock('$lib/server/auth/app-session', () => ({ markSessionVerified: mocks.markSessionVerified }));
vi.mock('$lib/server/auth/mfa', () => ({
	hasSecondFactor: mocks.hasSecondFactor,
	totpEnabled: () => true,
	verifySecondFactorCode: mocks.verifySecondFactorCode
}));
vi.mock('$lib/server/auth/passkeys', () => ({ listPasskeys: () => [] }));
vi.mock('$lib/server/auth/rate-limit', () => ({ isLockedOut: mocks.isLockedOut, recordFailure: mocks.recordFailure }));
vi.mock('$lib/server/auth/user', () => ({ verifyPasswordForUser: mocks.verifyPasswordForUser }));
vi.mock('$lib/server/auth/webauthn', () => ({
	verifyAuthentication: mocks.verifyAuthentication,
	registrationOptions: mocks.registrationOptions
}));

import { POST } from './+server';
import { POST as registerOptions } from '../passkey/register/options/+server';

const user = { id: 'u1', email: 'me@example.test' };

async function stepUp(body: Record<string, unknown>) {
	try {
		const res = await POST({
			locals: { user, sessionId: 's1' },
			request: new Request('http://localhost/api/auth/step-up', { method: 'POST', body: JSON.stringify(body) }),
			url: new URL('http://localhost/api/auth/step-up'),
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
	mocks.hasSecondFactor.mockReturnValue(true);
});

describe('POST /api/auth/step-up', () => {
	it('marks the session verified after a right code', async () => {
		mocks.verifySecondFactorCode.mockReturnValue('totp');
		expect(await stepUp({ code: '123456' })).toBe(200);
		expect(mocks.markSessionVerified).toHaveBeenCalledWith('s1');
	});

	it('only takes the password while there is no second factor', async () => {
		mocks.verifyPasswordForUser.mockResolvedValue(true);
		expect(await stepUp({ password: 'right' })).toBe(401);
		expect(mocks.markSessionVerified).not.toHaveBeenCalled();

		mocks.hasSecondFactor.mockReturnValue(false);
		expect(await stepUp({ password: 'right' })).toBe(200);
	});

	it('refuses a passkey that belongs to someone else', async () => {
		mocks.verifyAuthentication.mockResolvedValue({ user_id: 'someone-else' });
		expect(await stepUp({ passkey: { id: 'pk' } })).toBe(401);
		mocks.verifyAuthentication.mockResolvedValue({ user_id: 'u1' });
		expect(await stepUp({ passkey: { id: 'pk' } })).toBe(200);
	});

	it('counts failures and stops when locked out', async () => {
		mocks.verifySecondFactorCode.mockReturnValue(null);
		expect(await stepUp({ code: '000000' })).toBe(401);
		expect(mocks.recordFailure).toHaveBeenCalledWith('step-up:u1', '203.0.113.7');

		mocks.isLockedOut.mockReturnValue(true);
		mocks.verifySecondFactorCode.mockReturnValue('totp');
		expect(await stepUp({ code: '123456' })).toBe(429);
	});
});

describe('routes behind a re-check', () => {
	const call = (verifiedAt: number | null) =>
		registerOptions({
			locals: { user, sessionId: 's1', sessionVerifiedAt: verifiedAt },
			url: new URL('http://localhost/api/auth/passkey/register/options')
		} as unknown as Parameters<typeof registerOptions>[0]);

	it('refuses to add a passkey without a recent re-check', async () => {
		for (const at of [null, Date.now() - 11 * 60_000]) {
			const res = await call(at);
			expect(res.status).toBe(403);
			expect(await res.json()).toMatchObject({ stepUp: true });
		}
		expect(mocks.registrationOptions).not.toHaveBeenCalled();
	});

	it('goes ahead within ten minutes of one', async () => {
		expect((await call(Date.now() - 60_000)).status).toBe(200);
	});
});
