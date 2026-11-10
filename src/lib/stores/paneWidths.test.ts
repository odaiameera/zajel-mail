// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import { LIST_WIDTH, SIDEBAR_WIDTH, clampWidth, listWidth, nudgeWidth, parseWidth, sidebarWidth, startWidthDrag } from './paneWidths';

afterEach(() => {
	sidebarWidth.set(SIDEBAR_WIDTH.fallback);
	listWidth.set(LIST_WIDTH.fallback);
	document.cookie = 'pane_sidebar_width=; path=/; max-age=0';
	document.cookie = 'pane_list_width=; path=/; max-age=0';
});

describe('pane widths', () => {
	it('keep to their limits, and fall back to the default for a missing or junk cookie', () => {
		expect(clampWidth(50, SIDEBAR_WIDTH)).toBe(SIDEBAR_WIDTH.min);
		expect(clampWidth(5000, LIST_WIDTH)).toBe(LIST_WIDTH.max);
		expect(parseWidth('312.6', LIST_WIDTH)).toBe(313);
		for (const raw of [undefined, null, '', 'wide', 'NaN']) expect(parseWidth(raw, SIDEBAR_WIDTH)).toBe(224);
		listWidth.set(10_000);
		expect(get(listWidth)).toBe(LIST_WIDTH.max);
	});

	it('follow a drag, capped by the room there is, and are saved when it ends', () => {
		const handle = document.createElement('div');
		document.body.append(handle);
		const drag = (type: string, x: number) =>
			handle.dispatchEvent(Object.assign(new MouseEvent(type, { clientX: x, button: 0 }), { pointerId: 1 }));
		listWidth.set(420);
		const states: boolean[] = [];
		handle.addEventListener('pointerdown', (e) =>
			startWidthDrag(e as PointerEvent, listWidth, { max: () => 600, onDragging: (d) => states.push(d) })
		);
		drag('pointerdown', 100);
		expect(document.body.style.cursor).toBe('col-resize');
		drag('pointermove', 180);
		expect(get(listWidth)).toBe(500);
		drag('pointermove', 900);
		expect(get(listWidth)).toBe(600);
		expect(document.cookie).not.toContain('pane_list_width');
		drag('pointerup', 900);
		expect(document.cookie).toContain('pane_list_width=600');
		expect(states).toEqual([true, false]);
		expect(document.body.style.cursor).toBe('');
		// After the drag, moving the pointer changes nothing.
		drag('pointermove', 100);
		expect(get(listWidth)).toBe(600);
		handle.remove();
	});

	it('move with the arrow keys, Shift for bigger steps, and save', () => {
		const key = (k: string, shiftKey = false) => new KeyboardEvent('keydown', { key: k, shiftKey });
		nudgeWidth(key('ArrowRight'), sidebarWidth, SIDEBAR_WIDTH);
		expect(get(sidebarWidth)).toBe(240);
		nudgeWidth(key('ArrowLeft', true), sidebarWidth, SIDEBAR_WIDTH);
		expect(get(sidebarWidth)).toBe(SIDEBAR_WIDTH.min);
		nudgeWidth(key('End'), sidebarWidth, SIDEBAR_WIDTH, 300);
		expect(get(sidebarWidth)).toBe(300);
		expect(document.cookie).toContain('pane_sidebar_width=300');
		nudgeWidth(key('a'), sidebarWidth, SIDEBAR_WIDTH);
		expect(get(sidebarWidth)).toBe(300);
	});

	it('reset to the default', () => {
		sidebarWidth.set(350);
		sidebarWidth.reset();
		expect(get(sidebarWidth)).toBe(224);
		expect(document.cookie).toContain('pane_sidebar_width=224');
	});
});
