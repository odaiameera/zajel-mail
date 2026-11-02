// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import type { CalendarInfo, EventInstance } from '$lib/calendar/types';
import TimeGrid from './TimeGrid.svelte';

const HOUR_H = 48;
const day = new Date(2026, 10, 3);
const calendars: CalendarInfo[] = [{ id: 'default', name: 'Calendar', color: '#0969da', hidden: false, isDefault: true }];
// A five-minute event: the kind a resize-handle click used to stretch to 15.
const short: EventInstance = {
	id: 'e1',
	calendarId: 'default',
	uid: 'u1',
	title: 'Short',
	description: '',
	location: '',
	start: new Date(2026, 10, 3, 10, 0).toISOString(),
	end: new Date(2026, 10, 3, 10, 5).toISOString(),
	allDay: false,
	recurring: false,
	recurrenceId: null,
	rrule: null,
	alarms: [],
	status: 'confirmed',
	attendees: [],
	organizer: null,
	timeZone: null
};

function setup() {
	const onEventMove = vi.fn();
	const onEventClick = vi.fn();
	const onCreateRange = vi.fn();
	const { container } = render(TimeGrid, {
		props: { days: [day], events: [short], calendars, onCreateRange, onEventClick, onEventMove, onSelectDay: vi.fn() }
	});
	const columns = container.querySelector('[data-time-grid-columns]') as HTMLElement;
	// jsdom does no layout: give the columns a real box so pointer positions map to minutes.
	columns.getBoundingClientRect = () =>
		({ left: 0, top: 0, width: 700, height: 24 * HOUR_H, right: 700, bottom: 24 * HOUR_H, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
	const handle = container.querySelector('.cursor-ns-resize') as HTMLElement;
	return { onEventMove, onEventClick, onCreateRange, columns, handle };
}

const pointer = (target: EventTarget, type: string, clientX: number, clientY: number) =>
	target.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0, clientX, clientY }));

afterEach(() => cleanup());

describe('TimeGrid pointer handling', () => {
	it('a plain click on the resize handle opens the event instead of saving it', () => {
		const { handle, onEventMove, onEventClick } = setup();
		pointer(handle, 'pointerdown', 10, 10 * HOUR_H + 6);
		pointer(window, 'pointerup', 10, 10 * HOUR_H + 6);
		expect(onEventMove).not.toHaveBeenCalled();
		expect(onEventClick).toHaveBeenCalledTimes(1);
	});

	it('a drag of the handle resizes to the snapped minute', () => {
		const { handle, onEventMove, onEventClick } = setup();
		pointer(handle, 'pointerdown', 10, 10 * HOUR_H + 6);
		pointer(window, 'pointermove', 10, 11 * HOUR_H);
		pointer(window, 'pointerup', 10, 11 * HOUR_H);
		expect(onEventClick).not.toHaveBeenCalled();
		expect(onEventMove).toHaveBeenCalledTimes(1);
		const [, start, end] = onEventMove.mock.calls[0] as [EventInstance, Date, Date];
		expect(start.getHours()).toBe(10);
		expect([end.getHours(), end.getMinutes()]).toEqual([11, 0]);
	});

	it('a touch that turns into a scroll (pointercancel) leaves no drag for the next tap to carry out', () => {
		const { columns, onCreateRange } = setup();
		pointer(columns, 'pointerdown', 100, 14 * HOUR_H);
		window.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true }));
		pointer(window, 'pointerup', 300, 300);
		expect(onCreateRange).not.toHaveBeenCalled();
	});
});
