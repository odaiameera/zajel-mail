import { readable } from 'svelte/store';
import { browser } from '$app/environment';

/**
 * The phone layout: anything narrower than Tailwind's `md` breakpoint
 * (768px). Kept in step with the `max-md:` / `md:` classes so CSS and script
 * agree on where the layout switches.
 *
 * Layout itself is done in CSS, so the first server-rendered paint is already
 * right on a phone. This store is only for behaviour CSS can't express —
 * whether a row click opens the reading pane or navigates, whether the
 * sidebar is a drawer. It starts false on the server and settles on mount.
 */
export const PHONE_QUERY = '(max-width: 767.98px)';

function mediaStore(query: string) {
	return readable(false, (set) => {
		// jsdom (the component tests) has no matchMedia.
		if (!browser || typeof window.matchMedia !== 'function') return;
		const mq = window.matchMedia(query);
		set(mq.matches);
		const onChange = (e: MediaQueryListEvent) => set(e.matches);
		mq.addEventListener('change', onChange);
		return () => mq.removeEventListener('change', onChange);
	});
}

export const isPhone = mediaStore(PHONE_QUERY);

/**
 * Below Tailwind's `lg` (1024px) — phones, phones in landscape, tablets in
 * portrait — every app's left column is a slide-in drawer rather than a
 * column, so the content keeps the width. Kept in step with the `max-lg:` /
 * `lg:` classes on the shell.
 */
export const DRAWER_QUERY = '(max-width: 1023.98px)';

export const sidebarIsDrawer = mediaStore(DRAWER_QUERY);
