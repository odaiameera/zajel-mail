// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';

import TextInput from './TextInput.svelte';
import Toggle from './Toggle.svelte';

afterEach(cleanup);

describe('TextInput', () => {
	it('only holds what is typed: Enter and leaving the field store nothing', async () => {
		render(TextInput, { props: { value: 'old', ariaLabel: 'Name' } });
		const field = screen.getByLabelText('Name') as HTMLInputElement;
		await fireEvent.input(field, { target: { value: 'new' } });
		await fireEvent.keyDown(field, { key: 'Enter' });
		await fireEvent.blur(field);
		expect(field.value).toBe('new');
	});
});

describe('Toggle', () => {
	it('is named for what it switches, with its state in aria-checked', async () => {
		const onChange = vi.fn();
		render(Toggle, { props: { checked: true, ariaLabel: 'Reading pane', onChange } });
		const toggle = screen.getByRole('switch', { name: 'Reading pane' });
		expect(toggle.getAttribute('aria-checked')).toBe('true');

		await fireEvent.click(toggle);
		expect(onChange).toHaveBeenCalledWith(false);
	});

	it('falls back to naming its state when it is given no label', () => {
		render(Toggle, { props: { checked: false } });
		expect(screen.getByRole('switch', { name: 'Off' }).getAttribute('aria-checked')).toBe('false');
	});
});
