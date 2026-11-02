// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/svelte';
import { writable } from 'svelte/store';

vi.mock('$app/navigation', () => ({ invalidateAll: vi.fn() }));
vi.mock('$lib/stores/userState', () => ({
	// As the server returns it: every preference is a string.
	userState: writable({ displayName: null, settings: { defaultPageSize: '25' } }),
	updateSettings: vi.fn()
}));

import Page from './+page.svelte';

afterEach(cleanup);

const data = {
	conversationView: true,
	markReadDelay: 1000,
	autoLoadImages: 'contacts_only',
	defaultSort: 'date_desc',
	keyboardShortcuts: true,
	trashRetentionDays: 0,
	otpTrashAfterCopy: true
};

describe('Settings → Messages', () => {
	it('shows the saved page size after a reload, although it is stored as a string', () => {
		render(Page, { props: { data } as never });
		expect((screen.getByLabelText('Messages per page') as HTMLSelectElement).value).toBe('25');
	});
});
