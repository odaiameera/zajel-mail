import { describe, expect, it } from 'vitest';
import { parseLocalDate, parseLocalTime } from './local-time';

describe('local times the model gives', () => {
	it('accepts moments that exist, leap days included', () => {
		expect(parseLocalTime('2026-11-03T10:00')).toEqual({ year: 2026, month: 11, day: 3, hour: 10, minute: 0, second: 0 });
		expect(parseLocalTime(' 2028-02-29T23:59:30 ')).toMatchObject({ month: 2, day: 29, second: 30 });
		expect(parseLocalDate('2028-02-29')).toMatchObject({ year: 2028, month: 2, day: 29, hour: 0 });
	});

	it('refuses dates and times that would otherwise roll over', () => {
		for (const value of [
			'2026-11-31T09:00',
			'2026-13-05T09:00',
			'2027-02-29T09:00',
			'2026-04-31T09:00',
			'2026-11-03T24:00',
			'2026-11-03T09:60',
			'2026-11-03T09:00:60',
			'2026-11-00T09:00',
			'2026-00-10T09:00'
		]) {
			expect(parseLocalTime(value), value).toBeNull();
		}
		for (const value of ['2026-02-30', '2026-11-03T10:00', 'tomorrow', 42, null]) {
			expect(parseLocalDate(value), String(value)).toBeNull();
		}
		expect(parseLocalTime('2026-11-03')).toBeNull();
		expect(parseLocalTime(undefined)).toBeNull();
	});
});
