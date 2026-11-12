import { INBOX_CATEGORIES, type InboxCategory } from '$lib/types/categories';

/**
 * Why a message is in the Inbox tab it is in now, as the app recorded it.
 * Shown by the tab chip in the message view (its hover text, its name for
 * a screen reader, and a toast when it is tapped).
 *
 * - `chosen`: you moved it there yourself.
 * - `pin`: a sender pin put it there (`sender` is an address or `@domain`).
 * - `jev`: Jev picked the tab, this sure (0 to 1) when it said.
 * - `none`: nothing recorded matches the tab it is in now (the record is
 *   older than a later move, or there is none).
 */
export type TabWhy =
	| { kind: 'chosen' }
	| { kind: 'pin'; sender: string }
	| { kind: 'jev'; confidence: number | null }
	| { kind: 'none' };

/** What of a Jev decision row the reason is read from. */
export interface TabRecord {
	status: string;
	category: string | null;
	confidence: number | null;
	applied: string | null;
	correctedTo: string | null;
	pinnedBy: string | null;
}

/**
 * The first reason that applies, and only one that matches `tab`, the tab
 * the message is in now: your own choice, then a pin, then Jev's pick.
 * Your choice is the latest word: once you have chosen a tab, an earlier
 * pin or pick says nothing about where the message is.
 */
export function tabWhy(record: TabRecord | null, tab: InboxCategory): TabWhy {
	if (!record) return { kind: 'none' };
	if (record.correctedTo !== null) return record.correctedTo === tab ? { kind: 'chosen' } : { kind: 'none' };
	if (record.status !== 'done' || record.applied !== tab) return { kind: 'none' };
	if (record.pinnedBy) return { kind: 'pin', sender: record.pinnedBy };
	if (record.category === tab) return { kind: 'jev', confidence: record.confidence };
	return { kind: 'none' };
}

const quoted = (name: string) => `“${name}”`;

/** "“A”", "“A” and “B”", "“A”, “B” and “C”". */
function listed(names: string[]): string {
	const q = names.map(quoted);
	return q.length === 1 ? q[0] : `${q.slice(0, -1).join(', ')} and ${q.at(-1)}`;
}

/** The chip's words before the reason is known, or when it can't be had: what it has always said. */
export function tabChipFallback(tab: InboxCategory): string {
	return `In the ${labelOf(tab)} tab`;
}

function labelOf(tab: InboxCategory): string {
	return INBOX_CATEGORIES.find((c) => c.key === tab)?.label ?? tab;
}

/**
 * The reason as one or two sentences: why it is in the tab, then the rules
 * that matched it when it arrived (by name, without repeats), if any did.
 */
export function tabReasonText(tab: InboxCategory, why: TabWhy, rules: string[] = []): string {
	const label = labelOf(tab);
	let text: string;
	switch (why.kind) {
		case 'chosen':
			text = `You moved this to ${label}.`;
			break;
		case 'pin':
			text = why.sender.startsWith('@')
				? `Mail from anyone at ${why.sender.slice(1)} is pinned to ${label}.`
				: `Mail from ${why.sender} is pinned to ${label}.`;
			break;
		case 'jev':
			text =
				why.confidence === null
					? `Jev put this in ${label}.`
					: `Jev put this in ${label} (${Math.round(why.confidence * 100)}% sure).`;
			break;
		default:
			text = `${tabChipFallback(tab)}.`;
	}
	const names = [...new Set(rules.filter((name) => name.trim() !== ''))];
	if (names.length === 0) return text;
	return `${text} ${names.length === 1 ? 'Rule' : 'Rules'} ${listed(names)} also matched.`;
}
