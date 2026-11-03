import { describe, expect, it } from 'vitest';
import { describeDevice, relativeTime } from './devices';

const IPHONE =
	'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';
const CHROME_WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';
const EDGE_WIN = `${CHROME_WIN} Edg/142.0.0.0`;
const FIREFOX_LINUX = 'Mozilla/5.0 (X11; Linux x86_64; rv:146.0) Gecko/20100101 Firefox/146.0';
const CHROME_ANDROID = 'Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36';
const SAFARI_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15';
const CHROME_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/142.0.0.0 Mobile/15E148 Safari/604.1';

describe('describeDevice', () => {
	it.each([
		[IPHONE, 'Safari on iOS'],
		[CHROME_WIN, 'Chrome on Windows'],
		[EDGE_WIN, 'Edge on Windows'],
		[FIREFOX_LINUX, 'Firefox on Linux'],
		[CHROME_ANDROID, 'Chrome on Android'],
		[SAFARI_MAC, 'Safari on macOS'],
		[CHROME_IOS, 'Chrome on iOS'],
		[null, 'Unknown device'],
		['curl/8.0', 'Browser']
	])('%s → %s', (ua, label) => {
		expect(describeDevice(ua)).toBe(label);
	});
});

describe('relativeTime', () => {
	const now = Date.UTC(2026, 10, 3, 12, 0, 0);
	it('reads SQLite timestamps as UTC', () => {
		expect(relativeTime('2026-11-03 11:55:00', now)).toBe('5m ago');
		expect(relativeTime('2026-11-03T11:55:00Z', now)).toBe('5m ago');
	});
	it.each([
		['2026-11-03 11:59:40', 'just now'],
		['2026-11-03 09:00:00', '3h ago'],
		['2026-11-01 12:00:00', '2d ago']
	])('%s → %s', (stamp, text) => {
		expect(relativeTime(stamp, now)).toBe(text);
	});
});
