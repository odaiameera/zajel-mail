// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ invalidateAll: vi.fn() }));
vi.mock('$app/navigation', () => ({ invalidateAll: mocks.invalidateAll }));
vi.mock('$app/environment', () => ({ browser: true }));

import { realtime } from './realtime';

class FakeEventSource {
	static instances: FakeEventSource[] = [];
	readyState = 0;
	onopen: (() => void) | null = null;
	onerror: (() => void) | null = null;
	constructor(public url: string) {
		FakeEventSource.instances.push(this);
	}
	addEventListener() {}
	close() {
		this.readyState = 2;
	}
	open() {
		this.readyState = 1;
		this.onopen?.();
	}
}
const latest = () => FakeEventSource.instances.at(-1)!;

let visibility: DocumentVisibilityState = 'visible';
function setVisibility(state: DocumentVisibilityState) {
	visibility = state;
	document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.spyOn(console, 'log').mockImplementation(() => {});
	vi.stubGlobal('EventSource', FakeEventSource);
	Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
	FakeEventSource.instances = [];
	visibility = 'visible';
	mocks.invalidateAll.mockClear();
});

afterEach(() => {
	realtime.disconnect();
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('realtime', () => {
	it('refreshes when the stream comes back, since Stalwart sends nothing on connect', () => {
		realtime.connect();
		latest().open();
		vi.advanceTimersByTime(1000);
		expect(mocks.invalidateAll).not.toHaveBeenCalled();

		// The browser's own retry after a drop reopens the same source.
		latest().onerror?.();
		latest().open();
		vi.advanceTimersByTime(1000);
		expect(mocks.invalidateAll).toHaveBeenCalledTimes(1);
	});

	it('refreshes after a reconnect it had to start itself', () => {
		realtime.connect();
		latest().open();
		latest().readyState = 2; // the browser gave up
		latest().onerror?.();
		vi.advanceTimersByTime(1000); // reconnect delay
		expect(FakeEventSource.instances).toHaveLength(2);
		latest().open();
		vi.advanceTimersByTime(1000);
		expect(mocks.invalidateAll).toHaveBeenCalledTimes(1);
	});

	it('replaces the stream when connected again, as the layout does after an account switch', () => {
		realtime.connect();
		const first = latest();
		first.open();
		vi.advanceTimersByTime(1000);

		realtime.connect();
		expect(first.readyState).toBe(2);
		expect(FakeEventSource.instances).toHaveLength(2);
		latest().open();
		vi.advanceTimersByTime(1000);
		// A reopened stream refreshes once, since Stalwart replays nothing.
		expect(mocks.invalidateAll).toHaveBeenCalledTimes(1);
	});

	it('refreshes when the app is shown again after a while', () => {
		realtime.connect();
		latest().open();

		setVisibility('hidden');
		vi.advanceTimersByTime(5_000);
		setVisibility('visible');
		vi.advanceTimersByTime(1000);
		expect(mocks.invalidateAll).not.toHaveBeenCalled();

		setVisibility('hidden');
		vi.advanceTimersByTime(10 * 60_000);
		setVisibility('visible');
		vi.advanceTimersByTime(1000);
		expect(mocks.invalidateAll).toHaveBeenCalledTimes(1);
	});
});
