// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { reordered, sortable, zoneAt, type SortableOptions, type SortMove } from './sortable';

/** The height each row is given: jsdom lays nothing out, so every rect is made up here. */
const ROW = 40;

let mounted: { node: HTMLElement; action: ReturnType<typeof sortable> }[] = [];

afterEach(() => {
	for (const { action } of mounted) action.destroy();
	mounted = [];
	document.body.innerHTML = '';
	document.body.removeAttribute('style');
});

/**
 * A list of rows, each with a handle and a name, one under the other from
 * the top of the page, with the action on it.
 */
function list(ids: string[], options: Partial<SortableOptions> = {}) {
	const node = document.createElement('ul');
	ids.forEach((id, i) => {
		const row = document.createElement('li');
		row.id = `row-${id}`;
		row.dataset.sortId = id;
		row.innerHTML = `<button type="button" data-sort-handle aria-label="Reorder ${id}"><svg></svg></button><span id="name-${id}">${id}</span>`;
		const top = i * ROW;
		row.getBoundingClientRect = () =>
			({ top, bottom: top + ROW, left: 0, right: 200, width: 200, height: ROW, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
		node.appendChild(row);
	});
	document.body.appendChild(node);
	const onMove = vi.fn<(move: SortMove) => void>();
	const action = sortable(node, { onMove, ...options });
	mounted.push({ node, action });
	return { node, action, onMove };
}

const row = (id: string) => document.querySelector<HTMLElement>(`[data-sort-id="${id}"]`)!;
const handle = (id: string) => row(id).querySelector<HTMLElement>('[data-sort-handle]')!;
const ghost = () => document.querySelector<HTMLElement>('.sort-ghost');
/** How far down the page a point is that sits `ratio` of the way down the row at `index`. */
const at = (index: number, ratio: number) => index * ROW + ratio * ROW;

function pointer(type: string, target: EventTarget, y: number, init: PointerEventInit = {}) {
	const event = new PointerEvent(type, {
		bubbles: true,
		cancelable: true,
		pointerId: 1,
		pointerType: 'mouse',
		button: 0,
		clientX: 10,
		clientY: y,
		...init
	});
	target.dispatchEvent(event);
	return event;
}

function key(target: EventTarget, name: string, init: KeyboardEventInit = {}) {
	const event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init });
	target.dispatchEvent(event);
	return event;
}

/** Press the handle of the row at `from` and carry it to `y`, without letting go. */
function carry(id: string, from: number, y: number) {
	pointer('pointerdown', handle(id), at(from, 0.5));
	pointer('pointermove', window, y);
}
/** Carry a row to `y` and let it go there. */
function drag(id: string, from: number, y: number) {
	carry(id, from, y);
	pointer('pointerup', window, y);
}

describe('zoneAt', () => {
	it('splits a row that takes nothing inside it in half', () => {
		expect(zoneAt(0, false)).toBe('before');
		expect(zoneAt(0.49, false)).toBe('before');
		expect(zoneAt(0.5, false)).toBe('after');
		expect(zoneAt(1, false)).toBe('after');
	});

	it('keeps the top and bottom quarters of a row that can nest for before and after', () => {
		expect(zoneAt(0, true)).toBe('before');
		expect(zoneAt(0.24, true)).toBe('before');
		expect(zoneAt(0.25, true)).toBe('into');
		expect(zoneAt(0.5, true)).toBe('into');
		expect(zoneAt(0.75, true)).toBe('into');
		expect(zoneAt(0.76, true)).toBe('after');
		expect(zoneAt(1, true)).toBe('after');
	});
});

describe('reordered', () => {
	const ids = ['a', 'b', 'c', 'd'];

	it('puts the moved id before or after the one it was let go on', () => {
		expect(reordered(ids, { id: 'd', targetId: 'b', zone: 'before' })).toEqual(['a', 'd', 'b', 'c']);
		expect(reordered(ids, { id: 'a', targetId: 'c', zone: 'after' })).toEqual(['b', 'c', 'a', 'd']);
		expect(reordered(ids, { id: 'a', targetId: 'd', zone: 'after' })).toEqual(['b', 'c', 'd', 'a']);
		expect(reordered(ids, { id: 'd', targetId: 'a', zone: 'before' })).toEqual(['d', 'a', 'b', 'c']);
	});

	it('counts "into" as after', () => {
		expect(reordered(ids, { id: 'a', targetId: 'b', zone: 'into' })).toEqual(['b', 'a', 'c', 'd']);
	});

	it('leaves the order alone when the move ends where it began', () => {
		expect(reordered(ids, { id: 'b', targetId: 'a', zone: 'after' })).toEqual(ids);
		expect(reordered(ids, { id: 'b', targetId: 'c', zone: 'before' })).toEqual(ids);
	});

	it('returns the same list for a row dropped on itself or an id that is not in it', () => {
		expect(reordered(ids, { id: 'b', targetId: 'b', zone: 'before' })).toBe(ids);
		expect(reordered(ids, { id: 'x', targetId: 'b', zone: 'before' })).toBe(ids);
		expect(reordered(ids, { id: 'b', targetId: 'x', zone: 'after' })).toBe(ids);
	});

	it('does not change the list it was given', () => {
		const given = [...ids];
		reordered(given, { id: 'd', targetId: 'a', zone: 'before' });
		expect(given).toEqual(ids);
	});
});

describe('sortable: the arrow keys on a handle', () => {
	it('move the row one place among the rows of a flat list', () => {
		const { onMove } = list(['a', 'b', 'c']);
		const down = key(handle('b'), 'ArrowDown');
		expect(onMove).toHaveBeenLastCalledWith({ id: 'b', targetId: 'c', zone: 'after' });
		expect(down.defaultPrevented).toBe(true);
		const up = key(handle('b'), 'ArrowUp');
		expect(onMove).toHaveBeenLastCalledWith({ id: 'b', targetId: 'a', zone: 'before' });
		expect(up.defaultPrevented).toBe(true);
		expect(onMove).toHaveBeenCalledTimes(2);
	});

	it('work from anything inside the handle', () => {
		const { onMove } = list(['a', 'b']);
		key(handle('a').querySelector('svg')!, 'ArrowDown');
		expect(onMove).toHaveBeenCalledWith({ id: 'a', targetId: 'b', zone: 'after' });
	});

	it('move nothing past either end', () => {
		const { onMove } = list(['a', 'b', 'c']);
		key(handle('a'), 'ArrowUp');
		key(handle('c'), 'ArrowDown');
		expect(onMove).not.toHaveBeenCalled();
	});

	it('are left alone with a modifier held, off a handle, and for any other key', () => {
		const { onMove } = list(['a', 'b', 'c']);
		for (const held of [{ altKey: true }, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }]) {
			expect(key(handle('b'), 'ArrowDown', held).defaultPrevented).toBe(false);
		}
		expect(key(document.getElementById('name-b')!, 'ArrowDown').defaultPrevented).toBe(false);
		expect(key(handle('b'), 'Enter').defaultPrevented).toBe(false);
		expect(key(handle('b'), 'ArrowLeft').defaultPrevented).toBe(false);
		expect(onMove).not.toHaveBeenCalled();
	});

	it('are handed to onStep when the list says what a step is, at the ends too', () => {
		const onStep = vi.fn();
		const { onMove } = list(['a', 'b', 'c'], { onStep });
		expect(key(handle('b'), 'ArrowUp').defaultPrevented).toBe(true);
		key(handle('c'), 'ArrowDown');
		key(handle('a'), 'ArrowUp');
		expect(onStep.mock.calls).toEqual([
			['b', 'up'],
			['c', 'down'],
			['a', 'up']
		]);
		expect(onMove).not.toHaveBeenCalled();
	});

	it('belong to the list the handle is in', () => {
		const first = list(['a', 'b']);
		const second = list(['c', 'd']);
		key(handle('c'), 'ArrowDown');
		expect(first.onMove).not.toHaveBeenCalled();
		expect(second.onMove).toHaveBeenCalledWith({ id: 'c', targetId: 'd', zone: 'after' });
	});
});

describe('sortable: dragging a row by its handle', () => {
	it('reports the row it was let go on, before it in its top half and after it in its bottom half', () => {
		const { onMove } = list(['a', 'b', 'c']);
		drag('a', 0, at(2, 0.25));
		expect(onMove).toHaveBeenLastCalledWith({ id: 'a', targetId: 'c', zone: 'before' });
		drag('a', 0, at(2, 0.75));
		expect(onMove).toHaveBeenLastCalledWith({ id: 'a', targetId: 'c', zone: 'after' });
		drag('c', 2, at(0, 0.1));
		expect(onMove).toHaveBeenLastCalledWith({ id: 'c', targetId: 'a', zone: 'before' });
		expect(onMove).toHaveBeenCalledTimes(3);
	});

	it('lands inside a row that can nest when let go on its middle, and beside it on its edges', () => {
		const canNest = vi.fn((id: string) => id !== 'c');
		const { onMove } = list(['a', 'b', 'c'], { canNest });
		drag('a', 0, at(1, 0.5));
		expect(onMove).toHaveBeenLastCalledWith({ id: 'a', targetId: 'b', zone: 'into' });
		expect(canNest).toHaveBeenCalledWith('b');
		drag('a', 0, at(1, 0.1));
		expect(onMove).toHaveBeenLastCalledWith({ id: 'a', targetId: 'b', zone: 'before' });
		drag('a', 0, at(1, 0.9));
		expect(onMove).toHaveBeenLastCalledWith({ id: 'a', targetId: 'b', zone: 'after' });
		// A row that can't nest is split in half.
		drag('a', 0, at(2, 0.4));
		expect(onMove).toHaveBeenLastCalledWith({ id: 'a', targetId: 'c', zone: 'before' });
	});

	it('goes by where the pointer was last, not where it passed', () => {
		const { onMove } = list(['a', 'b', 'c']);
		pointer('pointerdown', handle('a'), at(0, 0.5));
		pointer('pointermove', window, at(2, 0.9));
		pointer('pointermove', window, at(1, 0.2));
		pointer('pointerup', window, at(1, 0.2));
		expect(onMove).toHaveBeenCalledTimes(1);
		expect(onMove).toHaveBeenCalledWith({ id: 'a', targetId: 'b', zone: 'before' });
	});

	it('lands first or last when let go past either end of the list', () => {
		const { onMove } = list(['a', 'b', 'c']);
		// And says it was past the end, not on a row: a tree reads that as
		// "the very top" or "the very end", whatever level that row is on.
		drag('b', 1, -30);
		expect(onMove).toHaveBeenLastCalledWith({ id: 'b', targetId: 'a', zone: 'before', edge: 'start' });
		drag('b', 1, 3 * ROW + 50);
		expect(onMove).toHaveBeenLastCalledWith({ id: 'b', targetId: 'c', zone: 'after', edge: 'end' });
	});

	it('moves nothing when the row is let go where it was picked up', () => {
		const { onMove } = list(['a', 'b', 'c']);
		drag('b', 1, at(1, 0.9));
		expect(onMove).not.toHaveBeenCalled();
	});

	it('is not a drag until the pointer has moved 4px', () => {
		const { onMove } = list(['a', 'b', 'c']);
		pointer('pointerdown', handle('a'), 20);
		pointer('pointermove', window, 23);
		expect(ghost()).toBeNull();
		expect(row('a').hasAttribute('data-sort-dragging')).toBe(false);
		pointer('pointerup', window, 23);
		expect(onMove).not.toHaveBeenCalled();

		pointer('pointerdown', handle('a'), 20);
		pointer('pointermove', window, 24);
		expect(ghost()).not.toBeNull();
		pointer('pointerup', window, 24);
	});

	it('starts only from a handle, and only with the main mouse button', () => {
		const { onMove } = list(['a', 'b', 'c']);
		pointer('pointerdown', document.getElementById('name-a')!, at(0, 0.5));
		pointer('pointermove', window, at(2, 0.9));
		pointer('pointerup', window, at(2, 0.9));
		pointer('pointerdown', handle('a'), at(0, 0.5), { button: 2 });
		pointer('pointermove', window, at(2, 0.9));
		pointer('pointerup', window, at(2, 0.9));
		expect(ghost()).toBeNull();
		expect(onMove).not.toHaveBeenCalled();
	});

	it('follows a finger as it does the mouse', () => {
		const { onMove } = list(['a', 'b', 'c']);
		const touch = { pointerType: 'touch', pointerId: 7 };
		pointer('pointerdown', handle('a'), at(0, 0.5), touch);
		pointer('pointermove', window, at(1, 0.9), touch);
		pointer('pointerup', window, at(1, 0.9), touch);
		expect(onMove).toHaveBeenCalledWith({ id: 'a', targetId: 'b', zone: 'after' });
	});

	it('ignores another pointer while one is dragging', () => {
		const { onMove } = list(['a', 'b', 'c']);
		carry('a', 0, at(1, 0.9));
		pointer('pointermove', window, at(2, 0.9), { pointerId: 2 });
		pointer('pointerup', window, at(2, 0.9), { pointerId: 2 });
		expect(onMove).not.toHaveBeenCalled();
		expect(ghost()).not.toBeNull();
		pointer('pointerdown', handle('c'), at(2, 0.5), { pointerId: 2 });
		pointer('pointerup', window, at(1, 0.9));
		expect(onMove).toHaveBeenCalledTimes(1);
		expect(onMove).toHaveBeenCalledWith({ id: 'a', targetId: 'b', zone: 'after' });
	});

	it('keeps the page from scrolling or selecting under the drag', () => {
		list(['a', 'b', 'c']);
		document.body.style.userSelect = 'text';
		pointer('pointerdown', handle('a'), at(0, 0.5));
		expect(pointer('pointermove', window, at(0, 0.5) + 2).defaultPrevented).toBe(false);
		expect(pointer('pointermove', window, at(1, 0.9)).defaultPrevented).toBe(true);
		expect(document.body.style.userSelect).toBe('none');
		pointer('pointerup', window, at(1, 0.9));
		expect(document.body.style.userSelect).toBe('text');
	});
});

describe('sortable: where a row may land', () => {
	it('asks canPlace about the dragged row, the row under the pointer and the zone', () => {
		const canPlace = vi.fn(() => true);
		list(['a', 'b', 'c'], { canPlace, canNest: () => true });
		drag('a', 0, at(1, 0.5));
		// The last one is the edge, which there is none of on a row.
		expect(canPlace).toHaveBeenCalledWith('a', 'b', 'into', undefined);
		drag('a', 0, 3 * ROW + 50);
		expect(canPlace).toHaveBeenCalledWith('a', 'c', 'after', 'end');
	});

	it('falls back from inside a row to beside it, by which half the pointer is in', () => {
		const canPlace = (_id: string, _targetId: string, zone: string) => zone !== 'into';
		const { onMove } = list(['a', 'b', 'c'], { canNest: () => true, canPlace });
		drag('a', 0, at(2, 0.4));
		expect(onMove).toHaveBeenLastCalledWith({ id: 'a', targetId: 'c', zone: 'before' });
		drag('a', 0, at(2, 0.6));
		expect(onMove).toHaveBeenLastCalledWith({ id: 'a', targetId: 'c', zone: 'after' });
	});

	it('moves nothing, and marks nothing, where the row may not land at all', () => {
		const canPlace = (_id: string, targetId: string) => targetId !== 'b';
		const { onMove } = list(['a', 'b', 'c'], { canNest: () => true, canPlace });
		carry('a', 0, at(1, 0.5));
		expect(row('b').hasAttribute('data-sort-drop')).toBe(false);
		pointer('pointerup', window, at(1, 0.5));
		expect(onMove).not.toHaveBeenCalled();
		expect(ghost()).toBeNull();
	});

	it('does not fall back to the other side of a row that can’t nest', () => {
		const canPlace = (_id: string, _targetId: string, zone: string) => zone !== 'before';
		const { onMove } = list(['a', 'b', 'c'], { canPlace });
		drag('a', 0, at(2, 0.2));
		expect(onMove).not.toHaveBeenCalled();
		drag('c', 2, -30);
		expect(onMove).not.toHaveBeenCalled();
	});

	it('drops the mark when the pointer goes from a row that takes it to one that doesn’t', () => {
		const canPlace = (_id: string, targetId: string) => targetId !== 'c';
		const { onMove } = list(['a', 'b', 'c'], { canPlace });
		carry('a', 0, at(1, 0.9));
		expect(row('b').getAttribute('data-sort-drop')).toBe('after');
		pointer('pointermove', window, at(2, 0.2));
		expect(row('b').hasAttribute('data-sort-drop')).toBe(false);
		pointer('pointerup', window, at(2, 0.2));
		expect(onMove).not.toHaveBeenCalled();
	});
});

describe('sortable: what a drag shows, and what it leaves behind', () => {
	it('dims the row, carries a copy of it, and marks where it would land', () => {
		list(['a', 'b', 'c'], { canNest: () => true });
		carry('a', 0, at(1, 0.5));
		expect(row('a').hasAttribute('data-sort-dragging')).toBe(true);
		expect(row('b').getAttribute('data-sort-drop')).toBe('into');

		const copy = ghost()!;
		expect(copy.parentElement).toBe(document.body);
		expect(copy.getAttribute('aria-hidden')).toBe('true');
		expect(copy.textContent).toBe('a');
		expect(copy.style.width).toBe('200px');
		expect(copy.style.height).toBe(`${ROW}px`);
		// Not a row of the list, and no second copy of an id.
		expect(copy.hasAttribute('data-sort-id')).toBe(false);
		expect(copy.hasAttribute('data-sort-dragging')).toBe(false);
		expect(copy.id).toBe('');
		expect(copy.querySelector('[id]')).toBeNull();
		expect(document.querySelectorAll('[data-sort-id]')).toHaveLength(3);

		// The mark follows the pointer: one row at a time.
		pointer('pointermove', window, at(2, 0.1));
		expect(row('b').hasAttribute('data-sort-drop')).toBe(false);
		expect(row('c').getAttribute('data-sort-drop')).toBe('before');
		pointer('pointermove', window, at(2, 0.9));
		expect(row('c').getAttribute('data-sort-drop')).toBe('after');
		expect(document.querySelectorAll('[data-sort-drop]')).toHaveLength(1);
	});

	it('hangs the copy under the pointer, set in from the row’s own edge, and moves it up and down only', () => {
		list(['a', 'b', 'c']);
		const rect = row('b').getBoundingClientRect();
		row('b').getBoundingClientRect = () => ({ ...rect, left: 30, x: 30, right: 230 }) as DOMRect;
		pointer('pointerdown', handle('b'), at(1, 0.5));
		// Over the top of the third row: 24px in from the row's edge, 12px under the pointer.
		pointer('pointermove', window, 85, { clientX: 50 });
		expect(ghost()!.style.transform).toBe('translate(54px, 97px)');
		// Sideways moves it nowhere; down moves it down.
		pointer('pointermove', window, 85, { clientX: 250 });
		expect(ghost()!.style.transform).toBe('translate(54px, 97px)');
		pointer('pointermove', window, 95, { clientX: 250 });
		expect(ghost()!.style.transform).toBe('translate(54px, 107px)');
	});

	it('keeps the copy clear of the line when the line is under the pointer', () => {
		list(['a', 'b', 'c']);
		// The bottom half of the last row: the line is at its foot (120),
		// below the pointer, and the copy waits 10px under it.
		carry('a', 0, 105);
		expect(document.querySelector<HTMLElement>('.sort-line')!.style.transform).toBe('translate(0px, 119px)');
		expect(ghost()!.style.transform).toBe('translate(24px, 130px)');
		pointer('pointermove', window, 115);
		expect(ghost()!.style.transform).toBe('translate(24px, 130px)');
		// Past the line, it follows the pointer again.
		pointer('pointermove', window, 125);
		expect(ghost()!.style.transform).toBe('translate(24px, 137px)');
	});

	it('clears the dimming, the mark and the copy after a drop', () => {
		const { onMove } = list(['a', 'b', 'c']);
		drag('a', 0, at(2, 0.9));
		expect(onMove).toHaveBeenCalledTimes(1);
		expect(document.querySelector('[data-sort-dragging]')).toBeNull();
		expect(document.querySelector('[data-sort-drop]')).toBeNull();
		expect(ghost()).toBeNull();
	});

	it('has cleared them by the time onMove is called', () => {
		const seen: boolean[] = [];
		list(['a', 'b', 'c'], {
			onMove: () => seen.push(!!document.querySelector('[data-sort-dragging], [data-sort-drop], .sort-ghost'))
		});
		drag('a', 0, at(2, 0.9));
		expect(seen).toEqual([false]);
	});

	it('listens to nothing more once the row is let go', () => {
		const { onMove } = list(['a', 'b', 'c']);
		drag('a', 0, at(2, 0.9));
		pointer('pointermove', window, at(1, 0.5));
		pointer('pointerup', window, at(1, 0.5));
		expect(onMove).toHaveBeenCalledTimes(1);
		expect(ghost()).toBeNull();
		expect(document.querySelector('[data-sort-drop]')).toBeNull();
	});

	it('puts everything back on Escape, and keeps that Escape to itself', () => {
		const { onMove } = list(['a', 'b', 'c']);
		const heard = vi.fn();
		document.body.addEventListener('keydown', heard);
		carry('a', 0, at(2, 0.9));
		const escape = key(document.body, 'Escape');
		document.body.removeEventListener('keydown', heard);

		expect(escape.defaultPrevented).toBe(true);
		expect(heard).not.toHaveBeenCalled();
		expect(document.querySelector('[data-sort-dragging]')).toBeNull();
		expect(document.querySelector('[data-sort-drop]')).toBeNull();
		expect(ghost()).toBeNull();
		pointer('pointerup', window, at(2, 0.9));
		expect(onMove).not.toHaveBeenCalled();
	});

	it('leaves Escape alone when nothing is being dragged', () => {
		list(['a', 'b', 'c']);
		const heard = vi.fn();
		document.body.addEventListener('keydown', heard);
		// Pressed, not yet moved: still not a drag.
		pointer('pointerdown', handle('a'), at(0, 0.5));
		expect(key(document.body, 'Escape').defaultPrevented).toBe(false);
		pointer('pointerup', window, at(0, 0.5));
		expect(key(document.body, 'Escape').defaultPrevented).toBe(false);
		document.body.removeEventListener('keydown', heard);
		expect(heard).toHaveBeenCalledTimes(2);
	});

	it('puts everything back when the pointer is cancelled', () => {
		const { onMove } = list(['a', 'b', 'c']);
		carry('a', 0, at(2, 0.9));
		pointer('pointercancel', window, at(2, 0.9));
		expect(document.querySelector('[data-sort-dragging]')).toBeNull();
		expect(document.querySelector('[data-sort-drop]')).toBeNull();
		expect(ghost()).toBeNull();
		pointer('pointerup', window, at(2, 0.9));
		expect(onMove).not.toHaveBeenCalled();
	});
});

describe('sortable: switched off, updated, destroyed', () => {
	it('moves nothing by pointer or by key while disabled', () => {
		const onStep = vi.fn();
		const { onMove } = list(['a', 'b', 'c'], { disabled: true, onStep });
		drag('a', 0, at(2, 0.9));
		expect(ghost()).toBeNull();
		expect(key(handle('b'), 'ArrowDown').defaultPrevented).toBe(false);
		expect(onMove).not.toHaveBeenCalled();
		expect(onStep).not.toHaveBeenCalled();
	});

	it('follows its options as they change', () => {
		const { onMove, action } = list(['a', 'b', 'c']);
		const later = vi.fn();
		action.update({ onMove: later, disabled: true });
		drag('a', 0, at(2, 0.9));
		key(handle('a'), 'ArrowDown');
		expect(later).not.toHaveBeenCalled();

		action.update({ onMove: later });
		drag('a', 0, at(2, 0.9));
		key(handle('a'), 'ArrowDown');
		expect(later.mock.calls).toEqual([[{ id: 'a', targetId: 'c', zone: 'after' }], [{ id: 'a', targetId: 'b', zone: 'after' }]]);
		expect(onMove).not.toHaveBeenCalled();
	});

	it('reports a drop to the options it has when the row is let go', () => {
		const { onMove, action } = list(['a', 'b', 'c']);
		const later = vi.fn();
		carry('a', 0, at(2, 0.9));
		action.update({ onMove: later });
		pointer('pointerup', window, at(2, 0.9));
		expect(onMove).not.toHaveBeenCalled();
		expect(later).toHaveBeenCalledWith({ id: 'a', targetId: 'c', zone: 'after' });
	});

	it('sees rows added after it was set up', () => {
		const { node, onMove } = list(['a', 'b']);
		const added = row('b').cloneNode(true) as HTMLElement;
		added.dataset.sortId = 'c';
		added.getBoundingClientRect = () =>
			({ top: 2 * ROW, bottom: 3 * ROW, left: 0, right: 200, width: 200, height: ROW, x: 0, y: 2 * ROW, toJSON: () => ({}) }) as DOMRect;
		node.appendChild(added);
		key(handle('b'), 'ArrowDown');
		expect(onMove).toHaveBeenLastCalledWith({ id: 'b', targetId: 'c', zone: 'after' });
		drag('c', 2, at(0, 0.1));
		expect(onMove).toHaveBeenLastCalledWith({ id: 'c', targetId: 'a', zone: 'before' });
	});

	it('ends a drag under way, and listens to nothing, once destroyed', () => {
		const { onMove, action } = list(['a', 'b', 'c']);
		carry('a', 0, at(2, 0.9));
		action.destroy();
		expect(document.querySelector('[data-sort-dragging]')).toBeNull();
		expect(document.querySelector('[data-sort-drop]')).toBeNull();
		expect(ghost()).toBeNull();
		pointer('pointerup', window, at(2, 0.9));
		drag('a', 0, at(2, 0.9));
		key(handle('a'), 'ArrowDown');
		expect(onMove).not.toHaveBeenCalled();
	});
});

describe('sortable: keeping the focus after a key moved a row', () => {
	/** What the page does once the move is stored: the row is put where it now belongs, which drops its focus. */
	function reload(node: HTMLElement, id: string, before: string | null) {
		const moved = row(id);
		moved.remove();
		node.insertBefore(moved, before ? row(before) : null);
	}
	/** Mutation observers report after the current task. */
	const settled = () => new Promise((r) => setTimeout(r, 0));

	it('puts the focus back on the moved row’s handle when the list reloads in its new order', async () => {
		const { node } = list(['a', 'b', 'c']);
		handle('a').focus();
		key(handle('a'), 'ArrowDown');
		reload(node, 'a', 'c');
		expect(document.activeElement).toBe(document.body);
		await settled();
		expect(document.activeElement).toBe(handle('a'));

		// And again, so the key can be held to carry a row down the list.
		key(handle('a'), 'ArrowDown');
		reload(node, 'a', null);
		await settled();
		expect(document.activeElement).toBe(handle('a'));
	});

	it('gives it back once a handle switched off during the save is on again', async () => {
		const { node } = list(['a', 'b', 'c']);
		const grip = handle('a') as HTMLButtonElement;
		grip.focus();
		key(grip, 'ArrowDown');
		// Switched off while the move is sent, the row put where it belongs
		// (which drops the focus), then switched on again.
		grip.disabled = true;
		reload(node, 'a', 'c');
		await settled();
		expect(document.activeElement).toBe(document.body);
		grip.disabled = false;
		await settled();
		expect(document.activeElement).toBe(grip);
	});

	it('leaves the focus where it was taken meanwhile', async () => {
		const { node } = list(['a', 'b', 'c']);
		const elsewhere = document.createElement('input');
		document.body.appendChild(elsewhere);
		handle('a').focus();
		key(handle('a'), 'ArrowDown');
		elsewhere.focus();
		reload(node, 'a', 'c');
		await settled();
		expect(document.activeElement).toBe(elsewhere);
	});

	it('doesn’t take the focus after a drag, which never had it', async () => {
		const { node } = list(['a', 'b', 'c']);
		drag('a', 0, at(2, 0.9));
		reload(node, 'a', null);
		await settled();
		expect(document.activeElement).toBe(document.body);
	});
});

describe('sortable: the line where a drop would land', () => {
	const line = () => document.querySelector<HTMLElement>('.sort-line');

	it('is drawn between the rows for before and after, and taken away with the drop', () => {
		list(['a', 'b', 'c']);
		expect(line()).toBeNull();
		carry('a', 0, at(2, 0.2));
		expect(line()?.hidden).toBe(false);
		// At the top edge of the row it would land before...
		expect(line()!.style.transform).toBe(`translate(0px, ${2 * ROW - 1}px)`);
		pointer('pointermove', window, at(2, 0.8));
		// ...and at the bottom edge of the one it would land after.
		expect(line()!.style.transform).toBe(`translate(0px, ${3 * ROW - 1}px)`);
		pointer('pointerup', window, at(2, 0.8));
		expect(line()).toBeNull();
	});

	it('is hidden while the drop would go inside a row, which is marked whole instead', () => {
		list(['a', 'b', 'c'], { canNest: () => true });
		carry('a', 0, at(1, 0.5));
		expect(row('b').getAttribute('data-sort-drop')).toBe('into');
		expect(line()?.hidden).toBe(true);
		pointer('pointermove', window, at(1, 0.1));
		expect(line()?.hidden).toBe(false);
	});

	it('goes with a drag that is cancelled', () => {
		list(['a', 'b', 'c']);
		carry('a', 0, at(2, 0.2));
		key(window, 'Escape');
		expect(line()).toBeNull();
	});
});
