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

const disc = (container: HTMLElement) => container.firstElementChild as HTMLElement;

describe('SenderAvatar', () => {
	it('shows an avatar that finished loading before it could hear the load event', async () => {
		stubImages({ complete: true, naturalWidth: 64 });
		const { container } = render(SenderAvatar, { email: 'no-reply@revolut.com', name: 'Revolut' });
		await tick();
		const { img, chip } = parts(container);
		expect(img.getAttribute('src')).toBe('/api/avatar?email=no-reply%40revolut.com');
		expect(disc(container).dataset.status).toBe('loaded');
		expect(img.style.visibility).toBe('visible');
		expect(img.style.backgroundColor).toBe('rgb(255, 255, 255)');
		expect(chip.style.opacity).toBe('0');
	});

	it('never shows the coloured initial while an avatar may still come', async () => {
		// The chip under a loading logo was the red flash before every avatar.
		stubImages({ complete: false, naturalWidth: 0 });
		const { container } = render(SenderAvatar, { email: 'no-reply@revolut.com', name: 'Revolut' });
		await tick();
		const { img, chip } = parts(container);
		expect(disc(container).dataset.status).toBe('pending');
		expect(chip.style.opacity).toBe('0');
		// Painted as soon as the browser has it: no opacity gate, no white plate yet.
		expect(img.style.opacity).toBe('');
		expect(img.style.backgroundColor).toBe('transparent');
		img.dispatchEvent(new Event('load'));
		await tick();
		expect(disc(container).dataset.status).toBe('loaded');
		expect(chip.style.opacity).toBe('0');
		expect(img.style.backgroundColor).toBe('rgb(255, 255, 255)');
	});

	it('brings the initial in only once there is no avatar: the endpoint’s 204, or an error', async () => {
		stubImages({ complete: false, naturalWidth: 0 });
		const { container } = render(SenderAvatar, { email: 'no-reply@revolut.com', name: 'Revolut' });
		await tick();
		const { img, chip } = parts(container);
		img.dispatchEvent(new Event('error'));
		await tick();
		expect(disc(container).dataset.status).toBe('missing');
		expect(chip.style.opacity).toBe('1');
		expect(chip.textContent?.trim()).toBe('R');
		// Hidden, not removed: removing it would reset the avatar and load it again, forever.
		expect(parts(container).img).toBe(img);
		expect(img.style.visibility).toBe('hidden');
	});

	it('knows a miss that settled before hydration', async () => {
		stubImages({ complete: true, naturalWidth: 0 });
		const { container } = render(SenderAvatar, { email: 'no-reply@revolut.com', name: 'Revolut' });
		await tick();
		expect(disc(container).dataset.status).toBe('missing');
		expect(parts(container).chip.style.opacity).toBe('1');
	});

	it('shows the initial straight away when there is no address to look up', async () => {
		const { container } = render(SenderAvatar, { email: '', name: 'Dana' });
		await tick();
		expect(disc(container).dataset.status).toBe('missing');
		expect(container.querySelector('img')).toBeNull();
		expect(parts(container).chip.style.opacity).toBe('1');
	});

	it('starts over for a new sender rather than keeping the last one’s avatar', async () => {
		stubImages({ complete: false, naturalWidth: 0 });
		const { container, rerender } = render(SenderAvatar, { email: 'a@revolut.com', name: 'Revolut' });
		parts(container).img.dispatchEvent(new Event('load'));
		await tick();
		expect(disc(container).dataset.status).toBe('loaded');
		await rerender({ email: 'b@example.test', name: 'Bea' });
		await tick();
		expect(disc(container).dataset.status).toBe('pending');
		expect(parts(container).chip.style.opacity).toBe('0');
		expect(parts(container).chip.textContent?.trim()).toBe('B');
	});
});
