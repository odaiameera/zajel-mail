import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import {
	clearIdentitySignature,
	createSignature,
	deleteSignature,
	reloadUserState,
	setIdentitySignature,
	updateSettings,
	updateSignature,
	userState
} from './userState';

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

describe('signatures', () => {
	const work = { id: 1, name: 'Work', html: '<div>Dana</div>', isDefault: true };
	const home = { id: 2, name: 'Home', html: '<div>D.</div>', isDefault: false };

	beforeEach(() => userState.update((s) => ({ ...s, signatures: [work, home] })));

	it('keeps an edited one as the server stored it, not as it was sent', async () => {
		fetchMock.mockResolvedValue(Response.json({ ...home, name: 'Home', html: '<div>Dana W.</div>' }));
		const stored = await updateSignature(2, { name: '  Home ', html: '<div style="color: red">Dana W.</div>' });
		expect(stored.html).toBe('<div>Dana W.</div>');
		expect(get(userState).signatures[1]).toEqual({ ...home, html: '<div>Dana W.</div>' });
	});

	it('leaves the store alone when an edit is refused, with the server’s reason', async () => {
		fetchMock.mockResolvedValue(Response.json({ error: 'The signature is too long.' }, { status: 413 }));
		await expect(updateSignature(2, { html: '<div>…</div>' })).rejects.toThrow('The signature is too long.');
		expect(get(userState).signatures).toEqual([work, home]);
	});

	it('moves the default mark when another one becomes the default', async () => {
		fetchMock.mockResolvedValue(Response.json({ ...home, isDefault: true }));
		await updateSignature(2, { isDefault: true });
		expect(get(userState).signatures.map((sig) => sig.isDefault)).toEqual([false, true]);
	});

	it('adds nothing when a new one is refused', async () => {
		fetchMock.mockResolvedValue(Response.json({ error: 'A signature needs a name.' }, { status: 400 }));
		await expect(createSignature(' ', '<div>x</div>')).rejects.toThrow('A signature needs a name.');
		expect(get(userState).signatures).toEqual([work, home]);
	});

	it('keeps one whose delete was refused', async () => {
		fetchMock.mockResolvedValue(Response.json({ error: 'Unauthorized' }, { status: 401 }));
		await expect(deleteSignature(2)).rejects.toThrow('Unauthorized');
		expect(get(userState).signatures).toEqual([work, home]);
	});
});

describe('reloadUserState', () => {
	it('reads as not loaded until the new account’s values are in', async () => {
		userState.update((s) => ({ ...s, loaded: true, signatures: [{ id: 1, name: 'Old', html: '', isDefault: true }] }));
		let seenWhileLoading: boolean | null = null;
		fetchMock.mockImplementation(async (url) => {
			seenWhileLoading ??= get(userState).loaded;
			if (String(url).endsWith('/user-state/signatures')) return Response.json([{ id: 9, name: 'New', html: '', isDefault: true }]);
			return Response.json(/settings|avatar/.test(String(url)) ? null : []);
		});
		await reloadUserState();
		expect(seenWhileLoading).toBe(false);
		expect(get(userState).loaded).toBe(true);
		expect(get(userState).signatures.map((sig) => sig.name)).toEqual(['New']);
	});
});
