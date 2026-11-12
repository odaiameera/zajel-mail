// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte';

import TextInput from './TextInput.svelte';
import Toggle from './Toggle.svelte';
import Segmented from './Segmented.svelte';
import RowMenu from './RowMenu.svelte';

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

describe('Segmented', () => {
	const options = [
		{ value: 'comfortable', label: 'Comfortable' },
		{ value: 'compact', label: 'Compact' }
	];

	it('is a radio group named for what it chooses, with the chosen one checked', () => {
		render(Segmented, { props: { value: 'compact', options, ariaLabel: 'Density', onchange: vi.fn() } });
		const group = screen.getByRole('radiogroup', { name: 'Density' });
		expect(within(group).getByRole('radio', { name: 'Compact' }).getAttribute('aria-checked')).toBe('true');
		expect(within(group).getByRole('radio', { name: 'Comfortable' }).getAttribute('aria-checked')).toBe('false');
	});

	it('chooses on a press, and says nothing for a press on the one already chosen', async () => {
		const onchange = vi.fn();
		render(Segmented, { props: { value: 'compact', options, ariaLabel: 'Density', onchange } });
		await fireEvent.click(screen.getByRole('radio', { name: 'Compact' }));
		expect(onchange).not.toHaveBeenCalled();
		await fireEvent.click(screen.getByRole('radio', { name: 'Comfortable' }));
		expect(onchange).toHaveBeenCalledWith('comfortable');
	});

	it('is one stop for Tab, and the arrow keys choose, going round at the ends', async () => {
		const onchange = vi.fn();
		render(Segmented, { props: { value: 'compact', options, ariaLabel: 'Density', onchange } });
		expect(screen.getByRole('radio', { name: 'Compact' }).tabIndex).toBe(0);
		expect(screen.getByRole('radio', { name: 'Comfortable' }).tabIndex).toBe(-1);

		await fireEvent.keyDown(screen.getByRole('radio', { name: 'Compact' }), { key: 'ArrowRight' });
		expect(onchange).toHaveBeenLastCalledWith('comfortable');
		await fireEvent.keyDown(screen.getByRole('radio', { name: 'Compact' }), { key: 'ArrowLeft' });
		expect(onchange).toHaveBeenLastCalledWith('comfortable');
	});
});

describe('RowMenu', () => {
	const items = () => {
		const edit = vi.fn();
		const remove = vi.fn();
		return {
			edit,
			remove,
			list: [
				{ label: 'Edit', onSelect: edit },
				{ label: 'Archive', onSelect: vi.fn(), disabled: true },
				{ label: 'Delete', onSelect: remove, danger: true }
			]
		};
	};
	const trigger = () => screen.getByRole('button', { name: 'Receipts options' });

	it('keeps a row’s actions behind one button, and runs the one that is pressed', async () => {
		const { edit, list } = items();
		render(RowMenu, { props: { items: list, ariaLabel: 'Receipts options' } });
		expect(screen.queryByRole('menu')).toBeNull();
		expect(trigger().getAttribute('aria-expanded')).toBe('false');

		await fireEvent.click(trigger());
		expect(trigger().getAttribute('aria-expanded')).toBe('true');
		await fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Edit' }));
		expect(edit).toHaveBeenCalledTimes(1);
		expect(screen.queryByRole('menu')).toBeNull();
	});

	it('doesn’t run an item that is switched off', async () => {
		const { list } = items();
		render(RowMenu, { props: { items: list, ariaLabel: 'Receipts options' } });
		await fireEvent.click(trigger());
		const archive = within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Archive' }) as HTMLButtonElement;
		expect(archive.disabled).toBe(true);
	});

	it('closes on Escape without running anything, and gives focus back to its button', async () => {
		const { edit, remove, list } = items();
		render(RowMenu, { props: { items: list, ariaLabel: 'Receipts options' } });
		await fireEvent.click(trigger());
		await fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
		expect(screen.queryByRole('menu')).toBeNull();
		expect(document.activeElement).toBe(trigger());
		expect(edit).not.toHaveBeenCalled();
		expect(remove).not.toHaveBeenCalled();
	});

	it('closes when something else is pressed', async () => {
		const { list } = items();
		render(RowMenu, { props: { items: list, ariaLabel: 'Receipts options' } });
		await fireEvent.click(trigger());
		await fireEvent.pointerDown(document.body);
		expect(screen.queryByRole('menu')).toBeNull();
	});
});
