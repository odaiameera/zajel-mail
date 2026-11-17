import { describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import { createReadingPaneStore } from './readingPane';

describe('the reading pane', () => {
	it('follows the saved setting when it changes, as after Save in Settings', () => {
		const pane = createReadingPaneStore(true);
		pane.follow(false);
		expect(get(pane)).toBe(false);
		pane.follow(true);
		expect(get(pane)).toBe(true);
	});

	it('keeps a saved choice whatever the width of the window', () => {
		const pane = createReadingPaneStore(true);
		pane.follow(false);
		pane.setFromViewport(1920);
		expect(get(pane)).toBe(false);
	});
});
