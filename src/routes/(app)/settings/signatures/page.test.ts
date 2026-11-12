// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { writable } from 'svelte/store';

const mocks = vi.hoisted(() => {
	const identity = (jmapId: string, email: string, isPrimary = false) => ({ jmapId, email, name: null, replyTo: null, isPrimary });
	return {
		setIdentitySignature: vi.fn(async () => {}),
		clearIdentitySignature: vi.fn(async () => {}),
		/** The user store as the app would have loaded it. */
		state: {
			loaded: true,
			signatures: [
				{ id: 1, name: 'Work', html: '<p>Regards</p>', isDefault: true },
				{ id: 2, name: 'Home', html: '<p>Cheers</p>', isDefault: false }
			],
			identities: [identity('id-1', 'me@example.test', true), identity('id-2', 'alias@example.test')],
			// The alias already has a signature of its own.
			identitySignatures: new Map([['id-2', 1]])
		}
	};
});
const state = mocks.state;

vi.mock('$app/navigation', () => ({ invalidateAll: vi.fn(), beforeNavigate: () => {} }));
vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/settings/signatures') } }));

vi.mock('$lib/stores/userState', () => ({
	userState: writable(mocks.state),
	setIdentitySignature: mocks.setIdentitySignature,
	clearIdentitySignature: mocks.clearIdentitySignature,
	refreshIdentities: vi.fn(),
	createSignature: vi.fn(),
	updateSignature: vi.fn(),
	deleteSignature: vi.fn()
}));

import Page from './+page.svelte';
import Harness from '../SettingsHarness.svelte';
import { barShown, discardButton, saveButton as barSave } from '$lib/settings/save-bar.testing';
import { userState } from '$lib/stores/userState';

const open = () => render(Harness, { props: { page: Page } as never });
const picker = (email: string) => screen.getByLabelText(`Default signature for ${email}`) as HTMLSelectElement;
/** The bar's Save. The signature editor has a Save of its own once a signature is open. */
const saveButton = () => barSave()!;
const nameField = () => screen.getByPlaceholderText('Signature name') as HTMLInputElement;

beforeEach(() => {
	(userState as unknown as { set(value: typeof state): void }).set(state);
	mocks.setIdentitySignature.mockReset().mockResolvedValue(undefined);
	mocks.clearIdentitySignature.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe('Settings → Signatures', () => {
	it('stores the per-address signatures when Save is pressed, and only the ones that moved', async () => {
		open();
		expect(picker('alias@example.test').value).toBe('1');

		await fireEvent.change(picker('me@example.test'), { target: { value: '2' } });
		await fireEvent.change(picker('alias@example.test'), { target: { value: '' } });
		expect(mocks.setIdentitySignature).not.toHaveBeenCalled();
		expect(mocks.clearIdentitySignature).not.toHaveBeenCalled();

		await fireEvent.click(saveButton());
		expect(await screen.findByText('Saved')).toBeTruthy();
		expect(mocks.setIdentitySignature.mock.calls).toEqual([['id-1', 2]]);
		expect(mocks.clearIdentitySignature.mock.calls).toEqual([['id-2']]);
	});

	it('puts the pickers back on Discard, and reads a choice undone by hand as no change', async () => {
		open();
		await fireEvent.change(picker('me@example.test'), { target: { value: '2' } });
		await fireEvent.click(discardButton()!);
		expect(picker('me@example.test').value).toBe('');
		expect(barShown()).toBe(false);

		await fireEvent.change(picker('me@example.test'), { target: { value: '2' } });
		expect(barShown()).toBe(true);
		await fireEvent.change(picker('me@example.test'), { target: { value: '' } });
		expect(barShown()).toBe(false);
		expect(mocks.setIdentitySignature).not.toHaveBeenCalled();
	});

	it('shows why a per-address signature didn’t save', async () => {
		mocks.setIdentitySignature.mockRejectedValueOnce(new Error('Couldn’t save. Try again.'));
		open();
		await fireEvent.change(picker('me@example.test'), { target: { value: '2' } });
		await fireEvent.click(saveButton());

		expect(await screen.findByText('Couldn’t save. Try again.')).toBeTruthy();
		expect(picker('me@example.test').value).toBe('2');
		expect(saveButton().disabled).toBe(false);
	});

	it('keeps an address that saved when another fails, naming the one that didn’t', async () => {
		mocks.clearIdentitySignature.mockRejectedValueOnce(new Error('Unauthorized'));
		open();
		await fireEvent.change(picker('me@example.test'), { target: { value: '2' } });
		await fireEvent.change(picker('alias@example.test'), { target: { value: '' } });
		await fireEvent.click(saveButton());

		expect(await screen.findByText('The signature for alias@example.test wasn’t saved: Unauthorized')).toBeTruthy();
		await fireEvent.click(saveButton());
		await screen.findByText('Saved');
		// The first address went the first time; only the second is sent again.
		expect(mocks.setIdentitySignature.mock.calls).toEqual([['id-1', 2]]);
		expect(mocks.clearIdentitySignature.mock.calls).toEqual([['id-2'], ['id-2']]);
	});

	it('has no Save bar for someone with a single address, who has no pickers', () => {
		(userState as unknown as { set(value: typeof state): void }).set({ ...state, identities: [state.identities[0]] });
		open();
		expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
	});

	describe('opening another signature over unsaved edits', () => {
		it('asks, and keeps the edits when the answer is no', async () => {
			const confirm = vi.fn(() => false);
			vi.stubGlobal('confirm', confirm);
			open();
			await fireEvent.click(screen.getByRole('button', { name: /Work/ }));
			await fireEvent.input(nameField(), { target: { value: 'Work (new)' } });

			await fireEvent.click(screen.getByRole('button', { name: 'Home' }));
			expect(confirm).toHaveBeenCalledWith('This signature has unsaved changes. Discard them?');
			expect(nameField().value).toBe('Work (new)');
		});

		it('opens the other one when the answer is yes', async () => {
			vi.stubGlobal('confirm', vi.fn(() => true));
			open();
			await fireEvent.click(screen.getByRole('button', { name: /Work/ }));
			await fireEvent.input(nameField(), { target: { value: 'Work (new)' } });

			await fireEvent.click(screen.getByRole('button', { name: 'Home' }));
			expect(nameField().value).toBe('Home');
		});

		it('doesn’t ask when nothing was edited, or for a new signature nobody typed in', async () => {
			const confirm = vi.fn(() => false);
			vi.stubGlobal('confirm', confirm);
			open();
			await fireEvent.click(screen.getByRole('button', { name: /Work/ }));
			await fireEvent.click(screen.getByRole('button', { name: 'Home' }));
			expect(nameField().value).toBe('Home');

			await fireEvent.click(screen.getByRole('button', { name: /New signature/ }));
			await fireEvent.click(screen.getByRole('button', { name: /Work/ }));
			expect(nameField().value).toBe('Work');
			expect(confirm).not.toHaveBeenCalled();
		});
	});
});
