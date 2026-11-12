// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { get, writable } from 'svelte/store';

/*
 * Things outside Settings that change something and then navigate (the
 * profile card's account switch, the corner's new event / contact) ask
 * about unsaved settings before they change anything.
 */

const mocks = vi.hoisted(() => {
	const identity = (jmapId: string, email: string, isPrimary = false) => ({ jmapId, email, name: null, replyTo: null, isPrimary });
	return {
		goto: vi.fn(async (_to: string, _options?: unknown) => {}),
		leaveGuard: null as
			| ((navigation: { willUnload: boolean; cancel: () => void; to?: { url: URL } | null }) => void)
			| null,
		setIdentitySignature: vi.fn(async () => {}),
		state: {
			loaded: true,
			signatures: [
				{ id: 1, name: 'Work', html: '<p>Regards</p>', isDefault: true },
				{ id: 2, name: 'Home', html: '<p>Cheers</p>', isDefault: false }
			],
			identities: [identity('id-1', 'me@example.test', true), identity('id-2', 'alias@example.test')],
			identitySignatures: new Map<string, number>()
		}
	};
});

vi.mock('$app/navigation', () => ({
	goto: mocks.goto,
	invalidateAll: vi.fn(async () => {}),
	beforeNavigate: (guard: typeof mocks.leaveGuard) => {
		mocks.leaveGuard = guard;
	}
}));
vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/settings/messages/signatures') } }));
vi.mock('$lib/stores/userState', () => ({
	userState: writable(mocks.state),
	setIdentitySignature: mocks.setIdentitySignature,
	clearIdentitySignature: vi.fn(),
	refreshIdentities: vi.fn(),
	createSignature: vi.fn(),
	updateSignature: vi.fn(),
	deleteSignature: vi.fn()
}));
vi.mock('$lib/stores/profilePhoto', () => ({
	profilePhoto: { ...writable({ url: null, zoom: 1, offsetX: 0, offsetY: 0 }), hydrate: () => {}, save: vi.fn(), clear: vi.fn() }
}));

import Signatures from '../../routes/(app)/settings/messages/signatures/+page.svelte';
import Harness from '../../routes/(app)/settings/SettingsHarness.svelte';
import ProfileCard from '$lib/components/ProfileCard.svelte';
import CornerActions from '$lib/components/CornerActions.svelte';
import { newRequest } from '$lib/stores/create';
import { barShown } from './save-bar.testing';

const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
const switches = () => fetchMock.mock.calls.filter(([url]) => url === '/api/accounts/switch');
const confirm = vi.fn<() => boolean>();

beforeEach(() => {
	fetchMock.mockReset().mockImplementation(async () => Response.json({ success: true }));
	vi.stubGlobal('fetch', fetchMock);
	vi.stubGlobal('confirm', confirm);
	confirm.mockReset();
	mocks.goto.mockClear();
	newRequest.set(null);
	// What SvelteKit does on goto: the settings layout's guard sees the navigation.
	mocks.goto.mockImplementation(async (to: string) => {
		const cancel = vi.fn();
		mocks.leaveGuard?.({ willUnload: false, cancel, to: { url: new URL(to, 'http://localhost') } });
	});
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

/** Signatures open, with an address's signature picked and not saved. */
async function pendingSignatureChange() {
	render(Harness, { props: { page: Signatures } as never });
	const picker = screen.getByLabelText('Default signature for alias@example.test');
	await fireEvent.change(picker, { target: { value: '2' } });
	expect(barShown()).toBe(true);
}

function profileCard() {
	render(ProfileCard, {
		props: {
			displayName: 'Me',
			email: 'me@example.test',
			activeAccountId: 'acct-1',
			accounts: [
				{ id: 'acct-1', email: 'me@example.test', displayName: 'Me', color: '#123456', needsReauth: false },
				{ id: 'acct-2', email: 'work@example.test', displayName: 'Work', color: '#654321', needsReauth: false }
			],
			onClose: () => {}
		}
	});
	return screen.getByRole('button', { name: /work@example\.test/ });
}

describe('switching the account from the profile card', () => {
	it('asks first, and on no changes no account and keeps the change', async () => {
		await pendingSignatureChange();
		confirm.mockReturnValue(false);
		await fireEvent.click(profileCard());

		await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
		expect(confirm).toHaveBeenCalledWith('You have unsaved changes. Leave without saving?');
		expect(switches()).toEqual([]);
		expect(mocks.goto).not.toHaveBeenCalled();
		expect(barShown()).toBe(true);
	});

	it('on yes discards, switches once and goes, asking only once', async () => {
		await pendingSignatureChange();
		confirm.mockReturnValue(true);
		await fireEvent.click(profileCard());

		await waitFor(() => expect(mocks.goto).toHaveBeenCalledWith('/inbox', { invalidateAll: true }));
		expect(switches()).toHaveLength(1);
		expect(confirm).toHaveBeenCalledTimes(1);
		expect(barShown()).toBe(false);
		expect(mocks.setIdentitySignature).not.toHaveBeenCalled();
	});

	it('doesn’t ask when nothing on the page is changed', async () => {
		render(Harness, { props: { page: Signatures } as never });
		await fireEvent.click(profileCard());
		await waitFor(() => expect(switches()).toHaveLength(1));
		expect(confirm).not.toHaveBeenCalled();
	});
});

describe('the corner’s new event and contact', () => {
	async function pick(name: 'Event' | 'Contact') {
		render(CornerActions, { props: { assistantOpen: false, onToggleAssistant: () => {} } });
		await fireEvent.click(screen.getByRole('button', { name: 'New' }));
		await fireEvent.click(screen.getByRole('menuitem', { name }));
	}

	it('asks first, and on no asks for nothing and stays', async () => {
		await pendingSignatureChange();
		confirm.mockReturnValue(false);
		await pick('Event');

		await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
		expect(get(newRequest)).toBeNull();
		expect(mocks.goto).not.toHaveBeenCalled();
		expect(barShown()).toBe(true);
	});

	it('on yes discards, asks for the contact and goes, asking only once', async () => {
		await pendingSignatureChange();
		confirm.mockReturnValue(true);
		await pick('Contact');

		await waitFor(() => expect(mocks.goto).toHaveBeenCalledWith('/contacts'));
		expect(get(newRequest)).toBe('contact');
		expect(confirm).toHaveBeenCalledTimes(1);
		expect(barShown()).toBe(false);
	});

	it('doesn’t ask when nothing on the page is changed', async () => {
		render(Harness, { props: { page: Signatures } as never });
		await pick('Event');
		await waitFor(() => expect(mocks.goto).toHaveBeenCalledWith('/calendar'));
		expect(get(newRequest)).toBe('event');
		expect(confirm).not.toHaveBeenCalled();
	});
});
