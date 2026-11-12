import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { clearIdentitySignature, setIdentitySignature, updateSettings, userState } from './userState';

const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();

beforeEach(() => {
	fetchMock.mockReset();
	vi.stubGlobal('fetch', fetchMock);
	userState.update((s) => ({ ...s, settings: { defaultPageSize: '50' }, identitySignatures: new Map([['id-1', 1]]) }));
});

afterEach(() => vi.unstubAllGlobals());

describe('updateSettings', () => {
	it('puts a stored change in the store', async () => {
		fetchMock.mockResolvedValue(Response.json({ displayName: null, settings: { defaultPageSize: '25' } }));
		await updateSettings({ settings: { defaultPageSize: 25 } });
		expect(get(userState).settings.defaultPageSize).toBe(25);
	});

	it('throws the server’s reason for a refused change, and leaves the store as it was', async () => {
		fetchMock.mockResolvedValue(Response.json({ error: 'Unauthorized' }, { status: 401 }));
		await expect(updateSettings({ settings: { defaultPageSize: 25 } })).rejects.toThrow('Unauthorized');
		expect(get(userState).settings.defaultPageSize).toBe('50');
	});

	it('throws something readable when the refusal has no reason', async () => {
		fetchMock.mockResolvedValue(new Response('oops', { status: 500 }));
		await expect(updateSettings({ displayName: 'Ada' })).rejects.toThrow('Couldn’t save. Try again.');
	});
});

describe('per-address signatures', () => {
	it('leaves the store alone when setting one is refused', async () => {
		fetchMock.mockResolvedValue(Response.json({ error: 'identityId and signatureId required' }, { status: 400 }));
		await expect(setIdentitySignature('id-2', 3)).rejects.toThrow('identityId and signatureId required');
		expect(get(userState).identitySignatures.has('id-2')).toBe(false);
	});

	it('leaves the store alone when clearing one is refused', async () => {
		fetchMock.mockResolvedValue(Response.json({ error: 'Unauthorized' }, { status: 401 }));
		await expect(clearIdentitySignature('id-1')).rejects.toThrow('Unauthorized');
		expect(get(userState).identitySignatures.get('id-1')).toBe(1);
	});

	it('stores both when the server takes them', async () => {
		fetchMock.mockImplementation(async () => Response.json({ success: true }));
		await setIdentitySignature('id-2', 3);
		await clearIdentitySignature('id-1');
		expect([...get(userState).identitySignatures]).toEqual([['id-2', 3]]);
	});
});
