// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/svelte';

vi.mock('$app/navigation', () => ({ invalidateAll: vi.fn() }));

import Page from './+page.svelte';
import { PREF_KEYS } from '$lib/server/preferences';

afterEach(cleanup);

describe('Settings → Backup & reset', () => {
	it('lists exactly the preferences the server exports, imports and resets', () => {
		const { container } = render(Page);
		const listed = [...container.querySelectorAll('details li code')].map((el) => el.textContent);
		expect(listed).toEqual([...PREF_KEYS]);
		expect(screen.getByText(`What the file holds (${PREF_KEYS.length} settings)`)).toBeTruthy();
	});
});
