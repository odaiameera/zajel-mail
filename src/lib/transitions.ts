import { cubicOut } from 'svelte/easing';

/**
 * How the corner windows (the composer popup and Zajel) come and
 * go: a fade with a slight grow from the corner they're anchored to. The
 * agent's card does the same with CSS transitions, at the same timings.
 *
 * Any transform the element already has (the full-screen composer is
 * centred with one) is kept and the scale is added to it.
 */
export function cornerWindow(
	node: Element,
	{ duration = 200, easing = cubicOut, start = 0.95 }: { duration?: number; easing?: (t: number) => number; start?: number } = {}
) {
	const existing = getComputedStyle(node).transform;
	const base = existing === 'none' ? '' : existing;
	return {
		duration,
		easing,
		css: (t: number) => `opacity: ${t}; transform: ${base} scale(${start + (1 - start) * t});`
	};
}

/**
 * The sheet curve: quick out of the gate, a long soft landing. It is iOS's,
 * and what the phone drawer and the reading pane's header fold move on, so
 * things that slide in this app all settle the same way.
 */
export const SHEET_EASE = 'cubic-bezier(0.32, 0.72, 0, 1)';

/** Whether the system has been asked for less motion. */
export function prefersReducedMotion(): boolean {
	return (
		typeof window !== 'undefined' &&
		typeof window.matchMedia === 'function' &&
		window.matchMedia('(prefers-reduced-motion: reduce)').matches
	);
}

/**
 * Slide an element over from where something was a moment ago (`from`,
 * measured before the DOM changed) to where it is now: the FLIP technique.
 * It moves by translate and a horizontal scale, which the compositor runs
 * on its own, and leaves nothing on the element when it ends, so at rest
 * the element is wherever its own CSS puts it. Returns null when there is
 * nothing to move or no Web Animations API to move it with.
 */
export function glideFrom(
	node: HTMLElement,
	from: DOMRect,
	{ duration = 260, easing = SHEET_EASE }: { duration?: number; easing?: string } = {}
): Animation | null {
	if (typeof node.animate !== 'function') return null;
	const to = node.getBoundingClientRect();
	if (to.width === 0) return null;
	const dx = from.left - to.left;
	const sx = from.width / to.width;
	if (Math.abs(dx) < 0.5 && Math.abs(sx - 1) < 0.01) return null;
	return node.animate(
		[
			{ transformOrigin: 'left center', transform: `translateX(${dx}px) scaleX(${sx})` },
			{ transformOrigin: 'left center', transform: 'none' }
		],
		{ duration, easing }
	);
}

/**
 * How an Inbox tab's mail arrives when you switch tabs: a short slide in
 * from the side of the tab you moved to (1 for a tab to the right, -1 for
 * one to the left) while it fades up, so the content moves the way the
 * underline did. With reduced motion it only fades.
 *
 * Web Animations rather than a Svelte transition, because the list is the
 * same element before and after (only its rows change), and because nothing
 * is left on it afterwards: a transform that stayed would make the list the
 * containing block for anything fixed inside it.
 */
export function tabContentIn(node: HTMLElement, direction: 1 | -1): Animation[] {
	if (typeof node.animate !== 'function') return [];
	const fade: Keyframe[] = [{ opacity: 0 }, { opacity: 1 }];
	if (prefersReducedMotion()) {
		return [node.animate(fade, { duration: 150, easing: 'ease-out' })];
	}
	return [
		node.animate([{ transform: `translateX(${direction * 24}px)` }, { transform: 'none' }], {
			duration: 280,
			easing: SHEET_EASE
		}),
		// The fade is done well before the slide settles, so the mail is
		// readable while it lands rather than ghosting in the whole way.
		node.animate(fade, { duration: 180, easing: 'cubic-bezier(0, 0, 0.2, 1)' })
	];
}
