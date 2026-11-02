/**
 * The two Settings → Messages values the mail views read: how long an open
 * message waits before it is marked read, and the order the lists come in.
 * Stored as strings like every preference, so they are parsed here, once,
 * for the settings page and the views alike.
 */

export const DEFAULT_MARK_READ_DELAY = 1000;
export const MAX_MARK_READ_DELAY = 10_000;

/** Milliseconds, clamped to 0..10 s; anything unreadable is the default. */
export function parseMarkReadDelay(raw: string | undefined | null): number {
	if (raw === undefined || raw === null || raw === '') return DEFAULT_MARK_READ_DELAY;
	const n = parseInt(raw, 10);
	if (!Number.isFinite(n)) return DEFAULT_MARK_READ_DELAY;
	return Math.max(0, Math.min(MAX_MARK_READ_DELAY, n));
}

export const MAIL_SORTS = ['date_desc', 'date_asc', 'subject', 'from'] as const;
export type MailSort = (typeof MAIL_SORTS)[number];

export function isMailSort(v: unknown): v is MailSort {
	return (MAIL_SORTS as readonly unknown[]).includes(v);
}

export function parseMailSort(raw: string | undefined | null): MailSort {
	return isMailSort(raw) ? raw : 'date_desc';
}

export interface JmapComparator {
	property: string;
	isAscending: boolean;
}

/**
 * The `Email/query` sort for a list order. Subject and sender ties fall back
 * to newest first, so a thread of replies stays in reading order.
 */
export function jmapSort(sort: MailSort): JmapComparator[] {
	const newest = { property: 'receivedAt', isAscending: false };
	switch (sort) {
		case 'date_asc':
			return [{ property: 'receivedAt', isAscending: true }];
		case 'subject':
			return [{ property: 'subject', isAscending: true }, newest];
		case 'from':
			return [{ property: 'from', isAscending: true }, newest];
		default:
			return [newest];
	}
}
