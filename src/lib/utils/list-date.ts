/**
 * The time a row in a mail list shows, read against "now" (pass the $now
 * store's value, so labels roll over at midnight without a reload):
 *
 *   today            the time it arrived, "12:02 PM"
 *   yesterday        "Yesterday"
 *   the last week    the weekday, "Mon"
 *   this year        the date, "Nov 3"
 *   before that      the date with its year, "Nov 3, 2025"
 *
 * The list has no date headings, so each row carries its own date; it stays
 * short because the sender's name has the first claim on the line.
 */

function startOfDay(d: Date): number {
	return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export function formatListDate(receivedAt: string | number | Date, nowMs: number): string {
	const d = new Date(receivedAt);
	const today = new Date(nowMs);
	// Calendar days apart, by local midnights (so DST days still count as one).
	const days = Math.round((startOfDay(today) - startOfDay(d)) / 86_400_000);

	if (days === 0) return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
	if (days === 1) return 'Yesterday';
	if (days > 1 && days < 7) return d.toLocaleDateString(undefined, { weekday: 'short' });
	return d.toLocaleDateString(undefined, {
		month: 'short',
		day: 'numeric',
		...(d.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' })
	});
}

/** The full date and time, for the row's tooltip. */
export function formatFullDate(receivedAt: string | number | Date): string {
	return new Date(receivedAt).toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'short' });
}
