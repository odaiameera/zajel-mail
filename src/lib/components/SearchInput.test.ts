// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';

vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/search'), data: {} } }));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));

import SearchInput from './SearchInput.svelte';

afterEach(() => cleanup());

describe('SearchInput operator words', () => {
	it('turns “tab” followed by a space into a tab: operator, as it does “from”', async () => {
		for (const word of ['from', 'tab']) {
			render(SearchInput, { onSubmit: () => {} });
			const input = screen.getByPlaceholderText('Search mail') as HTMLInputElement;
			await fireEvent.input(input, { target: { value: word } });
			input.setSelectionRange(word.length, word.length);
			await fireEvent.keyDown(input, { key: ' ' });
			expect(input.value).toBe(`${word}:"`);
			cleanup();
		}
	});
});
