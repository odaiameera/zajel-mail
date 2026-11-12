/**
 * Rows reordered by dragging their handle.
 *
 * The list is the node the action is on. Inside it, a row carries
 * `data-sort-id` and the part it is dragged by carries `data-sort-handle`
 * (a button, so it can be focused). Pointer events cover the mouse, a pen
 * and a finger alike, which HTML5 drag-and-drop does not; the handle keeps
 * the page from scrolling under a finger (`touch-action: none` in
 * layout.css), so the rest of the row still scrolls the page.
 *
 * While a row is being dragged it is dimmed in place (`data-sort-dragging`),
 * a copy of it rides up and down with the pointer, and the row under the
 * pointer says where the drop would land (`data-sort-drop`: before, after
 * or into). Before and after are drawn as a line between the rows. The
 * copy hangs just below the pointer and a little to the right, never over
 * that line, so where the row will land is always in plain sight.
 * Escape, or letting go outside the list, puts everything back.
 *
 * Without a pointer: the arrow keys on a focused handle move its row, and
 * the handle keeps the focus through the reload that follows, so the key
 * can be pressed again.
 *
 * The action only reports the move. The page sends it and reloads; nothing
 * is rearranged here.
 */

export type SortZone = 'before' | 'after' | 'into';
export type SortEdge = 'start' | 'end';

export interface SortMove {
	/** The row that was dragged. */
	id: string;
	/** The row it was let go on. */
	targetId: string;
	zone: SortZone;
	/**
	 * Set when it was let go past the first or last row, not on one: the
	 * target is then that row. A tree reads it as "the very top" or "the
	 * very end", whatever level that row is on.
	 */
	edge?: SortEdge;
}

export interface SortableOptions {
	onMove: (move: SortMove) => void;
	/**
	 * Arrow up and down on a handle. Left out, they move the row one place
	 * among the rows of the list, which is right for a flat list; a tree
	 * says what one step means itself.
	 */
	onStep?: (id: string, direction: 'up' | 'down') => void;
	/** Whether a row can take another inside it. Left out, none can. */
	canNest?: (targetId: string) => boolean;
	/** Whether the dragged row may land there. Left out, anywhere. `edge` as in SortMove. */
	canPlace?: (id: string, targetId: string, zone: SortZone, edge?: SortEdge) => boolean;
	disabled?: boolean;
}

/** How far the pointer moves before a press on the handle becomes a drag. */
const THRESHOLD = 4;
/** Where the copy of the row hangs: to the right of the row's edge, below the pointer, clear of the line. */
const GHOST_INSET = 24;
const GHOST_DROP = 12;
const GHOST_CLEAR = 10;
/** How near the edge of the scrolling pane the pointer starts it scrolling, and how fast. */
const SCROLL_EDGE = 48;
const SCROLL_STEP = 10;

/**
 * Where a drop lands on a row, from how far down it the pointer is (0 at
 * the top edge, 1 at the bottom). A row that can take another inside it
 * keeps its top and bottom quarters for before and after, as the mail
 * sidebar does; any other row is split in half.
 */
export function zoneAt(ratio: number, nest: boolean): SortZone {
	if (!nest) return ratio < 0.5 ? 'before' : 'after';
	if (ratio < 0.25) return 'before';
	if (ratio > 0.75) return 'after';
	return 'into';
}

/** A flat list's ids after a move. "Into" has no meaning there and counts as after. */
export function reordered(ids: string[], move: SortMove): string[] {
	if (move.id === move.targetId || !ids.includes(move.id) || !ids.includes(move.targetId)) return ids;
	const rest = ids.filter((id) => id !== move.id);
	const at = rest.indexOf(move.targetId) + (move.zone === 'before' ? 0 : 1);
	return [...rest.slice(0, at), move.id, ...rest.slice(at)];
}

/** The row a drop would land on, and where. */
interface Aim {
	row: HTMLElement;
	zone: SortZone;
	edge?: SortEdge;
}

interface Drag {
	id: string;
	row: HTMLElement;
	handle: HTMLElement;
	pointerId: number;
	startX: number;
	startY: number;
	/**
	 * The copy only moves up and down: it keeps to the row's own left edge
	 * (where a drop lands is decided by height alone, and on a phone a copy
	 * that followed the finger sideways would leave the screen).
	 */
	left: number;
	/** Where the line is drawn down the page, while there is one. */
	lineY: number | null;
	x: number;
	y: number;
	active: boolean;
	ghost: HTMLElement | null;
	line: HTMLElement | null;
	scroller: HTMLElement | null;
	target: HTMLElement | null;
	zone: SortZone | null;
	edge: SortEdge | undefined;
	frame: number;
	userSelect: string;
}

function scrollParent(node: HTMLElement): HTMLElement | null {
	for (let el = node.parentElement; el; el = el.parentElement) {
		const overflow = getComputedStyle(el).overflowY;
		if ((overflow === 'auto' || overflow === 'scroll') && el.scrollHeight > el.clientHeight) return el;
	}
	return null;
}

export function sortable(node: HTMLElement, initial: SortableOptions) {
	let options = initial;
	let drag: Drag | null = null;

	const rows = () => [...node.querySelectorAll<HTMLElement>('[data-sort-id]')];
	const idOf = (row: HTMLElement) => row.dataset.sortId ?? '';

	/** The handle an event started on and the row it belongs to, if both are this list's. */
	function grabbed(target: EventTarget | null): { handle: HTMLElement; row: HTMLElement } | null {
		if (!(target instanceof Element)) return null;
		const handle = target.closest<HTMLElement>('[data-sort-handle]');
		if (!handle || !node.contains(handle)) return null;
		const row = handle.closest<HTMLElement>('[data-sort-id]');
		return row && node.contains(row) ? { handle, row } : null;
	}

	function onPointerDown(e: PointerEvent) {
		if (options.disabled || drag) return;
		if (e.pointerType === 'mouse' && e.button !== 0) return;
		const hit = grabbed(e.target);
		if (!hit) return;
		const rect = hit.row.getBoundingClientRect();
		drag = {
			id: idOf(hit.row),
			row: hit.row,
			handle: hit.handle,
			pointerId: e.pointerId,
			startX: e.clientX,
			startY: e.clientY,
			left: rect.left,
			lineY: null,
			x: e.clientX,
			y: e.clientY,
			active: false,
			ghost: null,
			line: null,
			scroller: null,
			target: null,
			zone: null,
			edge: undefined,
			frame: 0,
			userSelect: ''
		};
		// Moves keep coming here once the pointer is off the handle.
		try {
			hit.handle.setPointerCapture?.(e.pointerId);
		} catch {
			// A pointer that is already gone: the window listeners still end it.
		}
		window.addEventListener('pointermove', onPointerMove);
		window.addEventListener('pointerup', onPointerUp);
		window.addEventListener('pointercancel', cancel);
		window.addEventListener('keydown', onEscape, true);
	}

	function begin(d: Drag) {
		d.active = true;
		d.scroller = scrollParent(node);
		d.row.setAttribute('data-sort-dragging', '');
		d.userSelect = document.body.style.userSelect;
		document.body.style.userSelect = 'none';

		// A copy of the row to carry: nothing in it is live, and it is not a
		// row of the list (it hangs off the body).
		const rect = d.row.getBoundingClientRect();
		const ghost = d.row.cloneNode(true) as HTMLElement;
		ghost.removeAttribute('data-sort-id');
		ghost.removeAttribute('data-sort-dragging');
		ghost.removeAttribute('id');
		for (const el of ghost.querySelectorAll('[id]')) el.removeAttribute('id');
		ghost.setAttribute('aria-hidden', 'true');
		ghost.classList.add('sort-ghost');
		ghost.style.width = `${rect.width}px`;
		ghost.style.height = `${rect.height}px`;
		document.body.appendChild(ghost);
		d.ghost = ghost;

		const line = document.createElement('div');
		line.className = 'sort-line';
		line.setAttribute('aria-hidden', 'true');
		line.hidden = true;
		document.body.appendChild(line);
		d.line = line;

		d.frame = requestAnimationFrame(tick);
	}

	/**
	 * The copy hangs under the pointer, set in from the row's edge: below
	 * the row the pointer is on, so that row and the line stay in sight.
	 * A line under the pointer (a drop after the row it is on) holds the
	 * copy off until the pointer is past it.
	 */
	function carry(d: Drag) {
		if (!d.ghost) return;
		const top = Math.max(d.y + GHOST_DROP, d.lineY === null ? -Infinity : d.lineY + GHOST_CLEAR);
		d.ghost.style.transform = `translate(${d.left + GHOST_INSET}px, ${top}px)`;
	}

	/** The row under the pointer and where on it the drop would land. */
	function aim(d: Drag): Aim | null {
		const others = rows().filter((row) => row !== d.row);
		if (others.length === 0) return null;
		const tryRow = (row: HTMLElement, wanted: SortZone, fallback: SortZone | null, edge?: SortEdge): Aim | null => {
			const id = idOf(row);
			const allowed = (zone: SortZone) => !options.canPlace || options.canPlace(d.id, id, zone, edge);
			if (allowed(wanted)) return { row, zone: wanted, edge };
			if (fallback && fallback !== wanted && allowed(fallback)) return { row, zone: fallback, edge };
			return null;
		};
		for (const row of others) {
			const rect = row.getBoundingClientRect();
			if (d.y < rect.top || d.y >= rect.bottom) continue;
			const ratio = (d.y - rect.top) / Math.max(rect.height, 1);
			const nest = options.canNest?.(idOf(row)) ?? false;
			// A row that can't take this one inside it still takes it beside it.
			return tryRow(row, zoneAt(ratio, nest), nest ? zoneAt(ratio, false) : null);
		}
		// Past either end of the list: first or last.
		const first = others[0];
		const last = others[others.length - 1];
		if (d.y < first.getBoundingClientRect().top) return tryRow(first, 'before', null, 'start');
		if (d.y >= last.getBoundingClientRect().bottom) return tryRow(last, 'after', null, 'end');
		return null;
	}

	function show(d: Drag, next: Aim | null) {
		if (d.target && d.target !== next?.row) d.target.removeAttribute('data-sort-drop');
		d.target = next?.row ?? null;
		d.zone = next?.zone ?? null;
		d.edge = next?.edge;
		if (next) next.row.setAttribute('data-sort-drop', next.zone);
		mark(d, next);
		carry(d);
	}

	/**
	 * The line between two rows where the drop would land. It starts where
	 * the row's own content does (its padding, which in a tree is its
	 * level), and is placed afresh each time: the rows move under it when
	 * the pane scrolls.
	 */
	function mark(d: Drag, next: Aim | null) {
		const line = d.line;
		if (!line) return;
		if (!next || next.zone === 'into') {
			line.hidden = true;
			d.lineY = null;
			return;
		}
		const rect = next.row.getBoundingClientRect();
		const inset = parseFloat(getComputedStyle(next.row).paddingLeft) || 0;
		const left = rect.left + inset;
		line.hidden = false;
		line.style.width = `${Math.max(0, rect.right - left - 12)}px`;
		d.lineY = next.zone === 'before' ? rect.top : rect.bottom;
		line.style.transform = `translate(${left}px, ${d.lineY - 1}px)`;
	}

	/** Each frame of a drag: scroll the pane when the pointer is at its edge, and re-aim. */
	function tick() {
		const d = drag;
		if (!d?.active) return;
		if (d.scroller) {
			const rect = d.scroller.getBoundingClientRect();
			if (d.y < rect.top + SCROLL_EDGE) d.scroller.scrollTop -= SCROLL_STEP;
			else if (d.y > rect.bottom - SCROLL_EDGE) d.scroller.scrollTop += SCROLL_STEP;
		}
		show(d, aim(d));
		d.frame = requestAnimationFrame(tick);
	}

	function onPointerMove(e: PointerEvent) {
		const d = drag;
		if (!d || e.pointerId !== d.pointerId) return;
		d.x = e.clientX;
		d.y = e.clientY;
		if (!d.active) {
			if (Math.hypot(d.x - d.startX, d.y - d.startY) < THRESHOLD) return;
			begin(d);
		}
		e.preventDefault();
		show(d, aim(d));
	}

	function onPointerUp(e: PointerEvent) {
		const d = drag;
		if (!d || e.pointerId !== d.pointerId) return;
		const move: SortMove | null =
			d.active && d.target && d.zone
				? { id: d.id, targetId: idOf(d.target), zone: d.zone, ...(d.edge ? { edge: d.edge } : {}) }
				: null;
		finish();
		if (move) options.onMove(move);
	}

	function cancel() {
		finish();
	}

	function onEscape(e: KeyboardEvent) {
		if (e.key !== 'Escape' || !drag?.active) return;
		// The drag's own Escape: not the dialog's or the page's.
		e.preventDefault();
		e.stopPropagation();
		finish();
	}

	function finish() {
		const d = drag;
		drag = null;
		window.removeEventListener('pointermove', onPointerMove);
		window.removeEventListener('pointerup', onPointerUp);
		window.removeEventListener('pointercancel', cancel);
		window.removeEventListener('keydown', onEscape, true);
		if (!d) return;
		cancelAnimationFrame(d.frame);
		try {
			d.handle.releasePointerCapture?.(d.pointerId);
		} catch {
			// Already released.
		}
		d.row.removeAttribute('data-sort-dragging');
		d.target?.removeAttribute('data-sort-drop');
		d.ghost?.remove();
		d.line?.remove();
		if (d.active) document.body.style.userSelect = d.userSelect;
	}

	// --- Keeping the focus after a key moved a row ---
	//
	// The page reloads the list in its new order, and a row that is moved in
	// the document (or whose handle is switched off while the move is sent)
	// drops the focus onto nothing. Without the pointer the handle is the
	// only way to move a row, so the focus goes back to it: for a few
	// seconds after the key, whenever the list changes and nothing else has
	// taken the focus meanwhile.

	let keeping: { observer: MutationObserver; timer: ReturnType<typeof setTimeout> } | null = null;

	function stopKeeping() {
		keeping?.observer.disconnect();
		clearTimeout(keeping?.timer);
		keeping = null;
	}

	function keepFocus(id: string) {
		stopKeeping();
		const restore = () => {
			const active = document.activeElement;
			const handle = rows()
				.find((row) => idOf(row) === id)
				?.querySelector<HTMLButtonElement>('[data-sort-handle]');
			if (!handle) return;
			if (active === handle) return;
			// Somewhere else was chosen since: leave it there.
			if (active && active !== document.body) return stopKeeping();
			if (!handle.disabled) handle.focus({ preventScroll: true });
		};
		const observer = new MutationObserver(restore);
		observer.observe(node, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });
		keeping = { observer, timer: setTimeout(stopKeeping, 4000) };
	}

	function onKeyDown(e: KeyboardEvent) {
		if (options.disabled || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
		if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
		const hit = grabbed(e.target);
		if (!hit) return;
		e.preventDefault();
		const id = idOf(hit.row);
		const up = e.key === 'ArrowUp';
		keepFocus(id);
		if (options.onStep) {
			options.onStep(id, up ? 'up' : 'down');
			return;
		}
		const list = rows();
		const other = list[list.indexOf(hit.row) + (up ? -1 : 1)];
		if (other) options.onMove({ id, targetId: idOf(other), zone: up ? 'before' : 'after' });
	}

	node.addEventListener('pointerdown', onPointerDown);
	node.addEventListener('keydown', onKeyDown);

	return {
		update(next: SortableOptions) {
			options = next;
		},
		destroy() {
			finish();
			stopKeeping();
			node.removeEventListener('pointerdown', onPointerDown);
			node.removeEventListener('keydown', onKeyDown);
		}
	};
}
