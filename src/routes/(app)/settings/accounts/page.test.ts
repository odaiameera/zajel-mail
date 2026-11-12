// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte';

vi.mock('$app/navigation', () => ({ invalidateAll: vi.fn(async () => {}), beforeNavigate: () => {} }));
vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/settings/accounts') } }));

import Page from './+page.svelte';
import Harness from '../SettingsHarness.svelte';
import { barShown, discardButton, saveButton as barSave } from '$lib/settings/save-bar.testing';

const account = (id: string, email: string, displayName: string | null = null, needsReauth = false) => ({
	id,
	email,
	displayName,
	color: '#8B5CF6',
	needsReauth
});
const accounts = [
	account('a1', 'ada@example.test', 'Personal'),
	account('a2', 'ada@work.test', 'Work'),
	account('a3', 'studio@example.test', null, true)
];

const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
const open = (data: Record<string, unknown> = {}) =>
	render(Harness, { props: { page: Page, data: { displayName: 'Ada', accounts, activeAccountId: 'a1', ...data } } as never });
const name = () => screen.getByLabelText('Name') as HTMLInputElement;
const saveButton = () => barSave()!;
const row = (label: string) => screen.getByRole('button', { name: `Reorder ${label}` }).closest('[data-sort-id]') as HTMLElement;
const sent = (url: string) =>
	fetchMock.mock.calls.filter(([u]) => u === url).map(([, init]) => JSON.parse(String(init?.body ?? 'null')));

/** Open a row's menu and press one of its items. */
async function choose(label: string, item: string) {
	await fireEvent.click(screen.getByRole('button', { name: `${label} options` }));
	await fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: item }));
}

beforeEach(() => {
	fetchMock.mockReset().mockImplementation(async () => Response.json({ success: true }));
	vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe('Settings → Accounts: you', () => {
	it('has your photo and name on the same page as the mail accounts', () => {
		open();
		expect(screen.getByRole('region', { name: 'You' })).toBeTruthy();
		expect(screen.getByRole('region', { name: 'Mail accounts' })).toBeTruthy();
		expect(within(screen.getByRole('region', { name: 'You' })).getByText('Photo')).toBeTruthy();
		expect(name().value).toBe('Ada');
	});

	it('saves the name when Save is pressed, not on leaving the field or on Enter', async () => {
		open();
		await fireEvent.input(name(), { target: { value: ' Ada Lovelace ' } });
		await fireEvent.keyDown(name(), { key: 'Enter' });
		await fireEvent.blur(name());
		expect(fetchMock).not.toHaveBeenCalled();

		await fireEvent.click(saveButton());
		expect(await screen.findByText('Saved')).toBeTruthy();

		expect(sent('/api/preferences/settings')).toEqual([{ displayName: ' Ada Lovelace ' }]);
		// Shown as the server stored it.
		expect(name().value).toBe('Ada Lovelace');
	});

	it('shows the server’s reason when it refuses the name', async () => {
		fetchMock.mockImplementationOnce(async () => Response.json({ error: 'Name is too long' }, { status: 400 }));
		open();
		await fireEvent.input(name(), { target: { value: 'Someone else' } });
		await fireEvent.click(saveButton());

		expect(await screen.findByText('Name is too long')).toBeTruthy();
		expect(name().value).toBe('Someone else');
	});

	it('puts the saved name back on Discard, and hides the bar for a name typed back', async () => {
		open();
		expect(barShown()).toBe(false);
		await fireEvent.input(name(), { target: { value: 'Grace' } });
		expect(barShown()).toBe(true);
		await fireEvent.click(discardButton()!);
		expect(name().value).toBe('Ada');
		expect(barShown()).toBe(false);

		await fireEvent.input(name(), { target: { value: 'Adam' } });
		await fireEvent.input(name(), { target: { value: 'Ada' } });
		expect(barShown()).toBe(false);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe('Settings → Accounts: mail accounts', () => {
	it('marks the account in use with a check, not a tag, and names no account "Default"', () => {
		open();
		expect(within(row('Personal')).getByLabelText('In use')).toBeTruthy();
		expect(within(row('Work')).queryByLabelText('In use')).toBeNull();
		expect(screen.queryByText('Active')).toBeNull();
		expect(screen.queryByText('Default')).toBeNull();
	});

	it('moves an account with the arrow keys on its handle, sending the whole order', async () => {
		open();
		await fireEvent.keyDown(screen.getByRole('button', { name: 'Reorder Work' }), { key: 'ArrowUp' });
		await vi.waitFor(() => expect(sent('/api/accounts/reorder')).toEqual([{ ids: ['a2', 'a1', 'a3'] }]));

		await fireEvent.keyDown(screen.getByRole('button', { name: 'Reorder Work' }), { key: 'ArrowDown' });
		await vi.waitFor(() => expect(sent('/api/accounts/reorder')[1]).toEqual({ ids: ['a1', 'a3', 'a2'] }));
	});

	it('sends nothing for an arrow key at the end of the list, and has no Move buttons', async () => {
		open();
		await fireEvent.keyDown(screen.getByRole('button', { name: 'Reorder Personal' }), { key: 'ArrowUp' });
		expect(sent('/api/accounts/reorder')).toEqual([]);
		expect(screen.queryByRole('button', { name: /^Move/ })).toBeNull();
	});

	it('gives a lone account a handle that does nothing', () => {
		open({ accounts: [accounts[0]] });
		expect((screen.getByRole('button', { name: 'Reorder Personal' }) as HTMLButtonElement).disabled).toBe(true);
	});

	it('switches to another account from its menu, which the account in use doesn’t offer', async () => {
		open();
		await fireEvent.click(screen.getByRole('button', { name: 'Personal options' }));
		expect(within(screen.getByRole('menu')).queryByRole('menuitem', { name: 'Switch to' })).toBeNull();
		await fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });

		await choose('Work', 'Switch to');
		await vi.waitFor(() => expect(sent('/api/accounts/switch')).toEqual([{ id: 'a2' }]));
	});

	it('renames an account from its menu', async () => {
		open();
		await choose('Work', 'Rename');
		const field = screen.getByLabelText('Account name') as HTMLInputElement;
		await fireEvent.input(field, { target: { value: 'Office' } });
		await fireEvent.keyDown(field, { key: 'Enter' });
		await vi.waitFor(() => expect(sent('/api/accounts/a2')).toEqual([{ displayName: 'Office' }]));
	});

	it('asks before unlinking, saying what goes with the link', async () => {
		fetchMock.mockImplementation(async (url, init) =>
			url === '/api/accounts/a2' && !init?.method
				? Response.json({ unlink: { pendingSends: 2, enabledJobs: 0, searchIndexed: true, rules: 1 } })
				: Response.json({ success: true })
		);
		open();
		await choose('Work', 'Unlink');
		expect(await screen.findByText('2 scheduled emails won’t be sent, 1 rule is deleted, the search index goes.')).toBeTruthy();
		expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);

		await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
		expect(screen.queryByText('Unlink this account?')).toBeNull();
	});

	it('offers to reconnect an account whose password was refused, with its address filled in', async () => {
		open();
		expect(within(row('studio@example.test')).getByText('Sign in again')).toBeTruthy();
		await fireEvent.click(within(row('studio@example.test')).getByRole('button', { name: 'Reconnect' }));

		const dialog = screen.getByRole('dialog', { name: 'Reconnect' });
		const email = within(dialog).getByLabelText('Email address') as HTMLInputElement;
		expect(email.value).toBe('studio@example.test');
		expect(email.readOnly).toBe(true);
		// Its colour stays as it is: there is nothing to pick.
		expect(within(dialog).queryByText('Color:')).toBeNull();
	});
});
