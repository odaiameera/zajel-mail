// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ showToast: vi.fn(), goto: vi.fn(), invalidateAll: vi.fn() }));
vi.mock('$app/environment', () => ({ browser: true, dev: false, building: false }));
vi.mock('$app/navigation', () => ({ goto: mocks.goto, invalidateAll: mocks.invalidateAll }));
vi.mock('./toast', () => ({ showToast: mocks.showToast }));
vi.mock('$lib/notifications', () => ({ canNotify: () => false, showNotification: vi.fn() }));

import { calendarNotify, REMINDERS_KEY } from './calendarNotify';
import { CALENDAR_CHANGED_EVENT } from '$lib/calendar/api';

const NOW = new Date('2026-11-02T10:00:00Z').getTime();
const json = (body: unknown) =>
	new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
const fetchMock = vi.fn(async () => json({ tokens: {}, changed: [], reminders: [] }));
const reminderIn = (ms: number) => ({
	key: `u1::10:${new Date(NOW + ms + 600000).toISOString()}`,
	eventId: 'e1',
	title: 'Standup',
	start: new Date(NOW + ms + 600000).toISOString(),
	allDay: false,
	fireAt: NOW + ms,
	minutesBefore: 10
});
const options = { newEvents: true, reminders: true };

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
	vi.stubGlobal('fetch', fetchMock);
	localStorage.clear();
	// Another tab polled a moment ago, so this one is gated out of polling.
	localStorage.setItem('cal-last-poll-v1', JSON.stringify(NOW));
});

afterEach(() => {
	calendarNotify.stop();
	fetchMock.mockClear();
	mocks.showToast.mockClear();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe('calendarNotify across tabs', () => {
	it('a tab that is not the one polling still schedules reminders from the shared list', () => {
		localStorage.setItem(REMINDERS_KEY, JSON.stringify([reminderIn(60_000)]));
		calendarNotify.start(options);
		expect(fetchMock).not.toHaveBeenCalled();
		vi.advanceTimersByTime(60_000);
		expect(mocks.showToast).toHaveBeenCalledWith(expect.objectContaining({ message: 'Reminder: Standup in 10 min' }));
	});

	it('picks up the list the polling tab writes, through the storage event', () => {
		calendarNotify.start(options);
		localStorage.setItem(REMINDERS_KEY, JSON.stringify([reminderIn(120_000)]));
		window.dispatchEvent(new StorageEvent('storage', { key: REMINDERS_KEY }));
		vi.advanceTimersByTime(120_000);
		expect(mocks.showToast).toHaveBeenCalledTimes(1);
	});

	it('polls at once after this tab writes to the calendar, sending its zone', () => {
		calendarNotify.start(options);
		expect(fetchMock).not.toHaveBeenCalled();
		window.dispatchEvent(new Event(CALENDAR_CHANGED_EVENT));
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(JSON.parse(String(init.body)).timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
	});

	it('does not fire a reminder it already fired, but does fire the same event at a new time', () => {
		const first = reminderIn(30_000);
		localStorage.setItem(REMINDERS_KEY, JSON.stringify([first]));
		calendarNotify.start(options);
		vi.advanceTimersByTime(30_000);
		expect(mocks.showToast).toHaveBeenCalledTimes(1);
		// Rescheduled: the server keys by start, so the key differs.
		localStorage.setItem(REMINDERS_KEY, JSON.stringify([reminderIn(90_000)]));
		window.dispatchEvent(new StorageEvent('storage', { key: REMINDERS_KEY }));
		vi.advanceTimersByTime(60_000);
		expect(mocks.showToast).toHaveBeenCalledTimes(2);
	});
});
