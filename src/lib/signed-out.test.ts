import { afterEach, describe, expect, it, vi } from 'vitest';
import { SIGNED_OUT_HEADER, watchForSignOut } from './signed-out';

const original = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = original;
	vi.unstubAllGlobals();
});

function answer(status: number, signedOut: boolean): Response {
	return new Response('{}', { status, headers: signedOut ? { [SIGNED_OUT_HEADER]: '1' } : {} });
}

describe('watchForSignOut', () => {
	it('says so once, however many requests come back signed out', async () => {
		const native = vi.fn(async () => answer(401, true));
		vi.stubGlobal('window', globalThis);
		globalThis.fetch = native as unknown as typeof fetch;
		const told = vi.fn();
		watchForSignOut(told);
		const res = await fetch('/api/email/1/detail');
		await fetch('/api/email/2/detail');
		expect(res.status).toBe(401);
		expect(native).toHaveBeenCalledTimes(2);
		expect(told).toHaveBeenCalledTimes(1);
	});

	it('stays quiet for other refusals: a wrong password, a mail account to re-enter', async () => {
		vi.stubGlobal('window', globalThis);
		globalThis.fetch = vi.fn(async () => answer(401, false)) as unknown as typeof fetch;
		const told = vi.fn();
		watchForSignOut(told);
		await fetch('/api/auth/step-up', { method: 'POST' });
		expect(told).not.toHaveBeenCalled();
	});

	it('puts the page\'s fetch back when it stops', async () => {
		vi.stubGlobal('window', globalThis);
		const native = vi.fn(async () => answer(401, true)) as unknown as typeof fetch;
		globalThis.fetch = native;
		const told = vi.fn();
		const stop = watchForSignOut(told);
		expect(globalThis.fetch).not.toBe(native);
		stop();
		expect(globalThis.fetch).toBe(native);
		await fetch('/api/x');
		expect(told).not.toHaveBeenCalled();
	});
});
