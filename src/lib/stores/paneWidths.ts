import { writable, type Writable } from 'svelte/store';

/**
 * The two column widths you can drag in Mail: the sidebar (folders) and the
 * message list beside the reading pane. Kept for the whole session, so moving
 * between folders (each its own page, so a new list) keeps the width you set,
 * and saved in a cookie per browser, since the right width depends on the
 * screen; the server reads it back so the first paint already has it.
 */

export interface PaneLimits {
	min: number;
	max: number;
	fallback: number;
}

export const SIDEBAR_WIDTH: PaneLimits = { min: 180, max: 400, fallback: 224 };
export const LIST_WIDTH: PaneLimits = { min: 280, max: 900, fallback: 420 };

/** The reading pane never gets narrower than this when the list is dragged. */
export const MIN_READING_PANE = 360;

export const SIDEBAR_COOKIE = 'pane_sidebar_width';
export const LIST_COOKIE = 'pane_list_width';

export function clampWidth(value: number, limits: PaneLimits): number {
	if (!Number.isFinite(value)) return limits.fallback;
	return Math.round(Math.min(limits.max, Math.max(limits.min, value)));
}

/** A saved cookie value, or the default when there is none or it's junk. */
export function parseWidth(raw: string | undefined | null, limits: PaneLimits): number {
	const n = raw == null || raw === '' ? NaN : Number(raw);
	return Number.isFinite(n) ? clampWidth(n, limits) : limits.fallback;
}

export interface PaneWidth extends Writable<number> {
	/** Write the current value to its cookie (call when a drag ends). */
	save(): void;
	/** Back to the default, saved. */
	reset(): void;
}

function paneWidth(cookie: string, limits: PaneLimits): PaneWidth {
	let current = limits.fallback;
	const store = writable(current);
	store.subscribe((v) => (current = v));
	const set = (v: number) => store.set(clampWidth(v, limits));
	const save = () => {
		if (typeof document === 'undefined') return;
		document.cookie = `${cookie}=${current}; path=/; max-age=31536000; samesite=lax`;
	};
	return {
		subscribe: store.subscribe,
		set,
		update: (fn) => set(fn(current)),
		save,
		reset() {
			set(limits.fallback);
			save();
		}
	};
}

export const sidebarWidth = paneWidth(SIDEBAR_COOKIE, SIDEBAR_WIDTH);
export const listWidth = paneWidth(LIST_COOKIE, LIST_WIDTH);

/**
 * Drag a divider: the width follows the pointer from where the drag began,
 * capped by `max()` (the room there is right now), and is saved when you let
 * go. Pointer capture keeps the drag even when the pointer leaves the thin
 * handle, or crosses the email's iframe.
 */
export function startWidthDrag(
	e: PointerEvent,
	width: PaneWidth,
	opts: { max?: () => number; onDragging?: (dragging: boolean) => void } = {}
): void {
	if (e.button !== 0) return;
	e.preventDefault();
	const handle = e.currentTarget as HTMLElement;
	handle.setPointerCapture?.(e.pointerId);
	const startX = e.clientX;
	let start = 0;
	width.subscribe((v) => (start = v))();
	const body = document.body.style;
	const saved = { cursor: body.cursor, userSelect: body.userSelect };
	body.cursor = 'col-resize';
	body.userSelect = 'none';
	opts.onDragging?.(true);

	const move = (ev: PointerEvent) => {
		const next = start + (ev.clientX - startX);
		width.set(Math.min(next, opts.max?.() ?? Infinity));
	};
	const end = () => {
		handle.removeEventListener('pointermove', move);
		handle.removeEventListener('pointerup', end);
		handle.removeEventListener('pointercancel', end);
		body.cursor = saved.cursor;
		body.userSelect = saved.userSelect;
		opts.onDragging?.(false);
		width.save();
	};
	handle.addEventListener('pointermove', move);
	handle.addEventListener('pointerup', end);
	handle.addEventListener('pointercancel', end);
}

/** Arrow keys move a focused divider (Shift for bigger steps); Home and End go to the ends. */
export function nudgeWidth(e: KeyboardEvent, width: PaneWidth, limits: PaneLimits, max = Infinity): void {
	const step = e.shiftKey ? 64 : 16;
	const cap = (v: number) => Math.min(v, max);
	let handled = true;
	if (e.key === 'ArrowLeft') width.update((v) => cap(v - step));
	else if (e.key === 'ArrowRight') width.update((v) => cap(v + step));
	else if (e.key === 'Home') width.set(limits.min);
	else if (e.key === 'End') width.set(cap(limits.max));
	else handled = false;
	if (!handled) return;
	e.preventDefault();
	width.save();
}
