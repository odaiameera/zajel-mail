/**
 * Keeps keyboard focus inside a dialog while it is open: Tab from its last
 * control goes to its first, Shift+Tab from its first (or from the dialog
 * itself) to its last. On mount the dialog takes focus unless something in
 * it already has it, so the first Tab starts from inside.
 *
 * A Svelte action: `<div role="dialog" tabindex="-1" use:trapFocus>`.
 */

const FOCUSABLE =
	'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The controls Tab can reach inside `node`, in order. */
function focusables(node: HTMLElement): HTMLElement[] {
	return [...node.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
		(el) => !el.closest('[hidden], [inert]') && (typeof el.checkVisibility !== 'function' || el.checkVisibility())
	);
}

export function trapFocus(node: HTMLElement) {
	if (!node.contains(document.activeElement)) node.focus();

	function onkeydown(e: KeyboardEvent) {
		if (e.key !== 'Tab') return;
		const list = focusables(node);
		if (list.length === 0) {
			e.preventDefault();
			node.focus();
			return;
		}
		const first = list[0];
		const last = list[list.length - 1];
		const active = document.activeElement;
		if (e.shiftKey && (active === first || active === node || !node.contains(active))) {
			e.preventDefault();
			last.focus();
		} else if (!e.shiftKey && (active === last || !node.contains(active))) {
			e.preventDefault();
			first.focus();
		}
	}

	node.addEventListener('keydown', onkeydown);
	return {
		destroy() {
			node.removeEventListener('keydown', onkeydown);
		}
	};
}
