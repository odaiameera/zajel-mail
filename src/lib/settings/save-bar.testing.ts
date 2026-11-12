import { screen, within } from '@testing-library/svelte';

/**
 * Test only: reading the settings Save bar the way someone sees it. The bar
 * is always in the layout; while it is hidden it is aria-hidden, so its
 * buttons can't be found by role.
 */
export const bar = () => screen.getByTestId('save-bar');
export const barShown = () => bar().getAttribute('aria-hidden') !== 'true';
export const barText = () => within(bar()).getByRole('status', { hidden: true }).textContent?.trim() ?? '';
export const saveButton = () => within(bar()).queryByRole('button', { name: 'Save' }) as HTMLButtonElement | null;
export const discardButton = () => within(bar()).queryByRole('button', { name: 'Discard' }) as HTMLButtonElement | null;
