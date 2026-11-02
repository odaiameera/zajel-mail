import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isRedirect } from '@sveltejs/kit';

const mocks = vi.hoisted(() => ({
	verifyUserPassword: vi.fn(),
	isLockedOut: vi.fn(),
	isIpLockedOut: vi.fn(),
	recordFailure: vi.fn(),
	recordIpFailure: vi.fn(),
	recordSuccess: vi.fn(),
	createAppSession: vi.fn(() => 'session-1'),
	hasSecondFactor: vi.fn(),
	takeMfaAttempt: vi.fn(),
	verifySecondFactorCode: vi.fn(),
	deleteMfaChallenge: vi.fn()
}));
vi.mock('$lib/server/auth/user', () => ({ verifyUserPassword: mocks.verifyUserPassword }));
vi.mock('$lib/server/auth/app-session', () => ({ createAppSession: mocks.createAppSession }));
vi.mock('$lib/server/auth/rate-limit', () => ({
	isLockedOut: mocks.isLockedOut,
	isIpLockedOut: mocks.isIpLockedOut,
	recordFailure: mocks.recordFailure,
	recordIpFailure: mocks.recordIpFailure,
	recordSuccess: mocks.recordSuccess
}));
vi.mock('$lib/server/auth/mfa', () => ({
	createMfaChallenge: () => 'challenge-1',
	deleteMfaChallenge: mocks.deleteMfaChallenge,
	hasSecondFactor: mocks.hasSecondFactor,
	pendingMfaUser: () => null,
	takeMfaAttempt: mocks.takeMfaAttempt,
	totpEnabled: () => true,
	verifySecondFactorCode: mocks.verifySecondFactorCode
}));
vi.mock('$lib/server/auth/passkeys', () => ({ listPasskeys: () => [] }));

import { actions } from './+page.server';

const IP = '203.0.113.7';
type Result = { status: number; data: Record<string, unknown> } & Record<string, unknown>;

function cookieJar(initial: Record<string, string> = {}) {
	const jar = new Map(Object.entries(initial));
	return {
		jar,
		get: (name: string) => jar.get(name),
		set: (name: string, value: string) => jar.set(name, value),
		delete: (name: string) => jar.delete(name)
	};
}

async function run(action: 'password' | 'code', fields: Record<string, string>, cookies = cookieJar()) {
	const body = new FormData();
	for (const [key, value] of Object.entries(fields)) body.set(key, value);
	try {
		const result = await actions[action]!({
			request: new Request('http://localhost/login', { method: 'POST', body }),
			cookies,
			getClientAddress: () => IP
		} as unknown as Parameters<typeof actions.password>[0]);
		return { result: result as Result, cookies };
	} catch (thrown) {
		if (isRedirect(thrown)) return { redirect: thrown.location, cookies };
		throw thrown;
	}
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.isLockedOut.mockReturnValue(false);
	mocks.isIpLockedOut.mockReturnValue(false);
	mocks.verifyUserPassword.mockResolvedValue(undefined);
	mocks.hasSecondFactor.mockReturnValue(false);
});

describe('password step', () => {
	it('counts a wrong password against the email and IP, and against the IP alone', async () => {
		const { result } = await run('password', { email: 'me@example.test', password: 'nope' });
		expect(result?.status).toBe(401);
		expect(mocks.recordFailure).toHaveBeenCalledWith('me@example.test', IP);
		expect(mocks.recordIpFailure).toHaveBeenCalledWith(IP);
	});

	it('turns away an email longer than any address, before checking anything', async () => {
		const { result } = await run('password', { email: 'x'.repeat(255), password: 'secret' });
		expect(result?.status).toBe(400);
		expect(result?.data.email).toBe('');
		expect(mocks.verifyUserPassword).not.toHaveBeenCalled();
		expect(mocks.recordFailure).not.toHaveBeenCalled();
	});

	it('stops while the address is locked out, whatever email it tries', async () => {
		mocks.isIpLockedOut.mockReturnValue(true);
		const { result } = await run('password', { email: 'other@example.test', password: 'x' });
		expect(result?.status).toBe(429);
		expect(mocks.verifyUserPassword).not.toHaveBeenCalled();
	});

	it('signs straight in when no second factor is set up, unverified', async () => {
		mocks.verifyUserPassword.mockResolvedValue({ id: 'u1', email: 'me@example.test' });
		const { redirect, cookies } = await run('password', { email: 'me@example.test', password: 'right' });
		expect(redirect).toBe('/inbox');
		expect(mocks.createAppSession).toHaveBeenCalledWith('u1', undefined, IP, false);
		expect(cookies.jar.get('session')).toBe('session-1');
	});

	it('asks for the second step instead of signing in when one is set up', async () => {
		mocks.verifyUserPassword.mockResolvedValue({ id: 'u1', email: 'me@example.test' });
		mocks.hasSecondFactor.mockReturnValue(true);
		const { result, cookies } = await run('password', { email: 'me@example.test', password: 'right' });
		expect(result).toMatchObject({ secondStep: true, totp: true });
		expect(cookies.jar.get('mfa')).toBe('challenge-1');
		expect(cookies.jar.has('session')).toBe(false);
		expect(mocks.createAppSession).not.toHaveBeenCalled();
	});
});

describe('code step', () => {
	it('signs in, verified, with a right code', async () => {
		mocks.takeMfaAttempt.mockReturnValue('u1');
		mocks.verifySecondFactorCode.mockReturnValue('totp');
		const { redirect, cookies } = await run('code', { code: '123456' }, cookieJar({ mfa: 'challenge-1' }));
		expect(redirect).toBe('/inbox');
		expect(mocks.createAppSession).toHaveBeenCalledWith('u1', undefined, IP, true);
		expect(mocks.deleteMfaChallenge).toHaveBeenCalledWith('challenge-1');
		expect(cookies.jar.has('mfa')).toBe(false);
	});

	it('counts a wrong code against the address and the login', async () => {
		mocks.takeMfaAttempt.mockReturnValue('u1');
		mocks.verifySecondFactorCode.mockReturnValue(null);
		const { result } = await run('code', { code: '000000' }, cookieJar({ mfa: 'challenge-1' }));
		expect(result?.status).toBe(401);
		expect(result?.data.secondStep).toBe(true);
		expect(mocks.recordIpFailure).toHaveBeenCalledWith(IP);
		expect(mocks.recordFailure).toHaveBeenCalledWith('second-step:u1', '');
		expect(mocks.createAppSession).not.toHaveBeenCalled();
	});

	it('is not barred by the per-address lock, which a proxy without ADDRESS_HEADER makes everyone share', async () => {
		mocks.isIpLockedOut.mockReturnValue(true);
		mocks.takeMfaAttempt.mockReturnValue('u1');
		mocks.verifySecondFactorCode.mockReturnValue('totp');
		const { redirect } = await run('code', { code: '123456' }, cookieJar({ mfa: 'challenge-1' }));
		expect(redirect).toBe('/inbox');
	});

	it('still stops once this login has guessed wrong too often', async () => {
		mocks.isLockedOut.mockImplementation((scope: string) => scope === 'second-step:u1');
		mocks.takeMfaAttempt.mockReturnValue('u1');
		const { result } = await run('code', { code: '123456' }, cookieJar({ mfa: 'challenge-1' }));
		expect(result?.status).toBe(429);
		expect(mocks.verifySecondFactorCode).not.toHaveBeenCalled();
	});

	it('starts over when the second step has expired or was never begun', async () => {
		mocks.takeMfaAttempt.mockReturnValue(null);
		expect((await run('code', { code: '123456' }, cookieJar({ mfa: 'old' }))).result?.status).toBe(401);
		expect((await run('code', { code: '123456' })).result?.status).toBe(401);
		expect(mocks.verifySecondFactorCode).not.toHaveBeenCalled();
	});
});
