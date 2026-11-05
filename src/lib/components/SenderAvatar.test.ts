// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import { tick } from 'svelte';

import SenderAvatar from './SenderAvatar.svelte';

/**
 * An image the browser already has (the avatar cache, on a reload): it is
 * complete before anything listens, and no load event will ever reach the
 * component, because the app's CSP blocks the inline handler Svelte uses to
 * replay one after hydration.
 */
function stubImages(state: { complete: boolean; naturalWidth: number }) {
	vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(state.complete);
	vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(state.naturalWidth);
}

const parts = (container: HTMLElement) => ({
	img: container.querySelector('img') as HTMLImageElement,
	chip: container.querySelector('[aria-hidden="true"]') as HTMLElement
});

beforeEach(() => {
	// No canvas in jsdom: the plate falls back to white.
	vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe('SenderAvatar', () => {
	it('shows an avatar that finished loading before it could hear the load event', async () => {
		stubImages({ complete: true, naturalWidth: 64 });
		const { container } = render(SenderAvatar, { email: 'no-reply@revolut.com', name: 'Revolut' });
		await tick();
		const { img, chip } = parts(container);
		expect(img.getAttribute('src')).toBe('/api/avatar?email=no-reply%40revolut.com');
		expect(img.style.opacity).toBe('1');
		expect(chip.style.opacity).toBe('0');
	});

	it('keeps the initial for a miss (the endpoint’s empty 204) or a broken image', async () => {
		stubImages({ complete: true, naturalWidth: 0 });
		const { container } = render(SenderAvatar, { email: 'no-reply@revolut.com', name: 'Revolut' });
		await tick();
		const { img, chip } = parts(container);
		expect(img.style.opacity).toBe('0');
		expect(chip.style.opacity).toBe('1');
		expect(chip.textContent?.trim()).toBe('R');
	});

	it('still waits for the load event while the image is on its way', async () => {
		stubImages({ complete: false, naturalWidth: 0 });
		const { container } = render(SenderAvatar, { email: 'no-reply@revolut.com', name: 'Revolut' });
		await tick();
		const { img, chip } = parts(container);
		expect(img.style.opacity).toBe('0');
		img.dispatchEvent(new Event('load'));
		await tick();
		expect(img.style.opacity).toBe('1');
		expect(chip.style.opacity).toBe('0');
	});

	it('starts over for a new sender rather than keeping the last one’s avatar shown', async () => {
		stubImages({ complete: false, naturalWidth: 0 });
		const { container, rerender } = render(SenderAvatar, { email: 'a@revolut.com', name: 'Revolut' });
		const { img } = parts(container);
		img.dispatchEvent(new Event('load'));
		await tick();
		expect(img.style.opacity).toBe('1');
		await rerender({ email: 'b@example.test', name: 'Bea' });
		await tick();
		expect(parts(container).img.style.opacity).toBe('0');
		expect(parts(container).chip.textContent?.trim()).toBe('B');
	});
});
