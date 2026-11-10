import { describe, expect, it } from 'vitest';
import { formatListDate } from './list-date';

const local = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi);
// Tuesday 10 November 2026, 16:40.
const NOW = local(2026, 11, 10, 16, 40).getTime();
const time = (d: Date) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const weekday = (d: Date) => d.toLocaleDateString(undefined, { weekday: 'short' });

describe('a mail row’s date', () => {
	it('is the time for mail from today, from just after midnight on', () => {
		expect(formatListDate(local(2026, 11, 10, 12, 2), NOW)).toBe(time(local(2026, 11, 10, 12, 2)));
		expect(formatListDate(local(2026, 11, 10, 0, 1), NOW)).toBe(time(local(2026, 11, 10, 0, 1)));
	});

	it('says Yesterday for mail from before midnight, however recent', () => {
		expect(formatListDate(local(2026, 11, 9, 23, 59), NOW)).toBe('Yesterday');
		expect(formatListDate(local(2026, 11, 9, 0, 0), NOW)).toBe('Yesterday');
	});

	it('names the weekday within the last week, then gives the date', () => {
		expect(formatListDate(local(2026, 11, 8, 9), NOW)).toBe(weekday(local(2026, 11, 8)));
		expect(formatListDate(local(2026, 11, 4, 9), NOW)).toBe(weekday(local(2026, 11, 4)));
		// Seven days back would be "Tue", the same as today: a date instead.
		const weekAgo = local(2026, 11, 3, 9);
		expect(formatListDate(weekAgo, NOW)).toBe(weekAgo.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }));
	});

	it('adds the year only for mail from another year', () => {
		const lastYear = local(2025, 12, 31, 9);
		expect(formatListDate(lastYear, NOW)).toBe(
			lastYear.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
		);
		expect(formatListDate(local(2026, 1, 2), NOW)).not.toContain('2026');
	});

	it('rolls over at midnight: the same mail reads Yesterday the next day', () => {
		const mail = local(2026, 11, 10, 12, 2);
		expect(formatListDate(mail, local(2026, 11, 11, 0, 0).getTime())).toBe('Yesterday');
	});

	it('gives a date, not a weekday, for mail dated in the future', () => {
		const ahead = local(2026, 11, 12, 9);
		expect(formatListDate(ahead, NOW)).toBe(ahead.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }));
	});
});
