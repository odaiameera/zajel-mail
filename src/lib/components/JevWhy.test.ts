// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';

import JevWhy from './JevWhy.svelte';

const DECISION = {
	category: 'newsletters',
	confidence: 0.37,
	applied: null,
	correctedTo: null,
	probabilities: { important: 0.06, updates: 0.15, newsletters: 0.53, promotions: 0.26 },
	facts: { addressed_to_you_directly: true, has_list_unsubscribe: true },
	rules: [],
	pinnedBy: null,
	spamCheck: null,
	model: 'jev-1.13.0',
	mock: false
};

beforeEach(() => {
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => new Response(JSON.stringify({ decision: DECISION }), { status: 200 }))
	);
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

const chip = () => screen.findByRole('button', { name: /^Jev · / });
const card = () => screen.queryByRole('dialog', { name: 'Why is this here?' });

async function openCard(): Promise<HTMLElement> {
	render(JevWhy, { emailId: 'M1' });
	await fireEvent.click(await chip());
	const el = card();
	expect(el).not.toBeNull();
	return el!;
}

describe('JevWhy', () => {
	it('floats over the message instead of pushing it down', async () => {
		const classes = (await openCard()).className.split(/\s+/);
		// Positioned, so opening it can't make the message header any taller.
		expect(classes).toContain('absolute');
		// A long verdict scrolls inside the card rather than down the page.
		expect(classes).toContain('overflow-y-auto');
		expect(classes.some((c) => c.startsWith('max-h-'))).toBe(true);
	});

	it('stays open for clicks inside it, and closes on Escape, a click elsewhere, or its close button', async () => {
		await fireEvent.pointerDown(await openCard());
		expect(card()).not.toBeNull();

		await fireEvent.keyDown(window, { key: 'Escape' });
		expect(card()).toBeNull();

		await fireEvent.click(await chip());
		await fireEvent.pointerDown(document.body);
		expect(card()).toBeNull();

		await fireEvent.click(await chip());
		await fireEvent.click(screen.getByRole('button', { name: 'Close' }));
		expect(card()).toBeNull();
	});

	it('closes when you click into the message, which sits in an iframe the page never hears clicks from', async () => {
		await openCard();
		const frame = document.body.appendChild(document.createElement('iframe'));
		Object.defineProperty(document, 'activeElement', { configurable: true, get: () => frame });
		try {
			await fireEvent.blur(window);
			await vi.waitFor(() => expect(card()).toBeNull());
		} finally {
			delete (document as unknown as Record<string, unknown>).activeElement;
			frame.remove();
		}
	});

	it('stays open when you only switch to another window', async () => {
		await openCard();
		await fireEvent.blur(window);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(card()).not.toBeNull();
	});
});
