/**
 * Inbox categories: the tabs that split the Inbox into Important, Updates,
 * Newsletters and Promotions.
 *
 * A category is a keyword on the message, never a mailbox — the message
 * stays in the Inbox, and each tab is an Email/query filter, so paging and
 * counts stay server-side like the quick filters in `email-filters.ts`.
 *
 * Important has no keyword of its own: it is the Inbox minus the other
 * three. A message nobody has sorted (or that Jev was unsure about, or
 * couldn't reach) therefore lands in Important by construction, and nothing
 * can be hidden in Promotions because a classification failed.
 */

export type InboxCategory = 'important' | 'updates' | 'newsletters' | 'promotions';

export interface InboxCategoryDef {
	key: InboxCategory;
	label: string;
	/** One line on what belongs here — tab tooltip and picker hint. */
	description: string;
}

export const INBOX_CATEGORIES: InboxCategoryDef[] = [
	{
		key: 'important',
		label: 'Important',
		description: 'Mail written to you, or that needs you'
	},
	{
		key: 'updates',
		label: 'Updates',
		description: 'Notices about your accounts, orders, bills and security'
	},
	{
		key: 'newsletters',
		label: 'Newsletters',
		description: 'Things you subscribed to read'
	},
	{
		key: 'promotions',
		label: 'Promotions',
		description: 'Offers, sales and marketing'
	}
];

/** What the Inbox page needs to draw its tabs; null when tabs are off. */
export interface InboxTabsState {
	active: InboxCategory;
	unread: Record<InboxCategory, number>;
}

/** The tab shown when the URL names none. */
export const DEFAULT_INBOX_CATEGORY: InboxCategory = 'important';

/**
 * Keyword for each category that has one. Lowercase because JMAP servers
 * fold keywords to lowercase; `$`-prefixed so a keyword patch never
 * tokenizes as an array index (see `updateEmailMailboxes`).
 */
export const CATEGORY_KEYWORDS = {
	updates: '$cat_updates',
	newsletters: '$cat_newsletters',
	promotions: '$cat_promotions'
} as const satisfies Record<Exclude<InboxCategory, 'important'>, string>;

const KEYWORD_LIST: string[] = Object.values(CATEGORY_KEYWORDS);

const VALID = new Set<string>(INBOX_CATEGORIES.map((c) => c.key));

export function isInboxCategory(raw: unknown): raw is InboxCategory {
	return typeof raw === 'string' && VALID.has(raw);
}

/** Normalise a raw `?category=` value, defaulting to Important. */
export function parseInboxCategory(raw: string | null | undefined): InboxCategory {
	return isInboxCategory(raw) ? raw : DEFAULT_INBOX_CATEGORY;
}

/**
 * Link to a tab from the current Inbox URL. Keeps the quick filter, drops
 * the page number (each tab starts at its first page), and leaves the
 * default tab out of the URL so `/inbox` stays the Inbox's address.
 */
export function inboxTabHref(current: URL, category: InboxCategory): string {
	const url = new URL(current);
	if (category === DEFAULT_INBOX_CATEGORY) url.searchParams.delete('category');
	else url.searchParams.set('category', category);
	url.searchParams.delete('page');
	return url.pathname + url.search;
}

/** JMAP Email/query condition selecting one tab's mail (AND it with the Inbox). */
export function categoryCondition(category: InboxCategory): Record<string, unknown> {
	if (category === 'important') {
		// RFC 8620 §5.5: NOT matches when none of its conditions do.
		return {
			operator: 'NOT',
			conditions: KEYWORD_LIST.map((keyword) => ({ hasKeyword: keyword }))
		};
	}
	return { hasKeyword: CATEGORY_KEYWORDS[category] };
}

/**
 * Keyword changes that put a message in `category` and only there: its own
 * keyword on, every other category keyword off. Important clears them all.
 */
export function categoryKeywordPatch(category: InboxCategory): Record<string, boolean> {
	const target = category === 'important' ? null : CATEGORY_KEYWORDS[category];
	return Object.fromEntries(KEYWORD_LIST.map((keyword) => [keyword, keyword === target]));
}

/** Which tab a message is in, read from its keywords. */
export function categoryOf(keywords: Record<string, boolean>): InboxCategory {
	for (const [category, keyword] of Object.entries(CATEGORY_KEYWORDS)) {
		if (keywords[keyword]) return category as InboxCategory;
	}
	return 'important';
}
