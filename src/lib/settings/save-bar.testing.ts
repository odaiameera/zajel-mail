import { screen, within } from '@testing-library/svelte';

/**
 * Test only: reading the settings Save bar the way someone sees it. The bar
 * is always in the layout; while it is hidden it is see-through, holds no
 * buttons and its status line is empty.
 */
export const bar = () => screen.getByTestId('save-bar');
export const barShown = () => bar().dataset.shown === 'true';
export const barText = () => within(bar()).getByRole('status').textContent?.trim() ?? '';
export const saveButton = () => within(bar()).queryByRole('button', { name: 'Save' }) as HTMLButtonElement | null;
export const discardButton = () => within(bar()).queryByRole('button', { name: 'Discard' }) as HTMLButtonElement | null;
