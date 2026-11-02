import type { Email, EmailAddress } from '$lib/jmap/types';
import type { EmailMeta } from './vectors';

/**
 * The same JMAP filter drives both halves of a hybrid search: Stalwart runs
 * all of it, and the vector half takes its free text as the question and
 * holds its matches to the rest — mailbox and date before scoring, from what
 * the index stores, then everything against the messages as fetched.
 */

export type JmapFilter = Record<string, unknown>;

export interface SemanticQuery {
	/** The free text, asked of the vectors. */
	text: string;
	/** Every other condition, which vector matches must also meet. */
	rest: JmapFilter | null;
}

const TEXT_KEYS = new Set(['text']);

/** Conditions this module can check against a fetched message. */
const LOCAL_KEYS = new Set([
	'inMailbox', 'inMailboxOtherThan', 'before', 'after', 'minSize', 'maxSize',
	'hasKeyword', 'notKeyword', 'hasAttachment', 'from', 'to', 'cc', 'subject'
]);

function isOperator(filter: JmapFilter): filter is { operator: string; conditions: JmapFilter[] } {
	return typeof filter.operator === 'string' && Array.isArray(filter.conditions);
}

function mentionsText(filter: JmapFilter): boolean {
	if (isOperator(filter)) return filter.conditions.some(mentionsText);
	return Object.keys(filter).some((key) => TEXT_KEYS.has(key));
}

function checkable(filter: JmapFilter): boolean {
	if (isOperator(filter)) return filter.conditions.every(checkable);
	return Object.keys(filter).every((key) => LOCAL_KEYS.has(key));
}

/**
 * Split a filter into its free text and the rest. Null when there is no free
 * text, when the text sits under OR/NOT (where "the rest" has no meaning),
 * or when the rest has a condition that can't be checked locally (`body:`).
 */
export function splitSemantic(filter: JmapFilter | null): SemanticQuery | null {
	if (!filter) return null;
	const parts = isOperator(filter) ? (filter.operator === 'AND' ? filter.conditions : null) : [filter];
	if (!parts) return null;

	const text: string[] = [];
	const rest: JmapFilter[] = [];
	for (const part of parts) {
		if (isOperator(part)) {
			if (mentionsText(part)) return null;
			rest.push(part);
			continue;
		}
		const others: JmapFilter = {};
		for (const [key, value] of Object.entries(part)) {
			if (TEXT_KEYS.has(key)) {
				if (typeof value === 'string' && value.trim()) text.push(value.trim());
			} else others[key] = value;
		}
		if (Object.keys(others).length) rest.push(others);
	}

	if (text.length === 0) return null;
	if (!rest.every(checkable)) return null;
	return {
		text: text.join(' '),
		rest: rest.length === 0 ? null : rest.length === 1 ? rest[0] : { operator: 'AND', conditions: rest }
	};
}

function addresses(list: EmailAddress[] | null | undefined): string {
	return (list ?? []).map((a) => `${a.name ?? ''} <${a.email}>`).join(', ').toLowerCase();
}

function contains(haystack: string, needle: unknown): boolean {
	return typeof needle === 'string' && haystack.includes(needle.toLowerCase());
}

function conditionHolds(email: Email, key: string, value: unknown): boolean {
	const received = Date.parse(email.receivedAt);
	switch (key) {
		case 'inMailbox':
			return typeof value === 'string' && email.mailboxIds?.[value] === true;
		case 'inMailboxOtherThan':
			return Array.isArray(value) && Object.keys(email.mailboxIds ?? {}).some((id) => email.mailboxIds[id] && !value.includes(id));
		case 'before':
			return typeof value === 'string' && received < Date.parse(value);
		case 'after':
			return typeof value === 'string' && received >= Date.parse(value);
		case 'minSize':
			return email.size >= Number(value);
		case 'maxSize':
			return email.size < Number(value);
		case 'hasKeyword':
			return typeof value === 'string' && email.keywords?.[value] === true;
		case 'notKeyword':
			return typeof value === 'string' && email.keywords?.[value] !== true;
		case 'hasAttachment':
			return email.hasAttachment === value;
		case 'from':
			return contains(addresses(email.from), value);
		case 'to':
			return contains(addresses(email.to), value);
		case 'cc':
			return contains(addresses(email.cc), value);
		case 'subject':
			return contains((email.subject ?? '').toLowerCase(), value);
		default:
			return false;
	}
}

/** Does a fetched message meet the filter? Only for filters `splitSemantic` let through. */
export function matchesFilter(email: Email, filter: JmapFilter | null): boolean {
	if (!filter) return true;
	if (isOperator(filter)) {
		const results = filter.conditions.map((c) => matchesFilter(email, c));
		if (filter.operator === 'AND') return results.every(Boolean);
		if (filter.operator === 'OR') return results.some(Boolean);
		if (filter.operator === 'NOT') return !results.some(Boolean);
		return false;
	}
	return Object.entries(filter).every(([key, value]) => conditionHolds(email, key, value));
}

/**
 * The part of the filter the index can apply before scoring: mailboxes and
 * dates at the top level. The index hears of moves within a minute, and
 * `matchesFilter` checks the fetched copy again.
 */
export function indexPrefilter(filter: JmapFilter | null): (meta: EmailMeta) => boolean {
	if (!filter) return () => true;
	const parts = isOperator(filter) ? (filter.operator === 'AND' ? filter.conditions : []) : [filter];
	const checks: ((meta: EmailMeta) => boolean)[] = [];
	for (const part of parts) {
		if (isOperator(part)) continue;
		if (typeof part.inMailbox === 'string') {
			const id = part.inMailbox;
			checks.push((m) => m.mailboxIds.includes(id));
		}
		if (typeof part.after === 'string') {
			const at = Date.parse(part.after);
			if (!Number.isNaN(at)) checks.push((m) => m.receivedAt >= at);
		}
		if (typeof part.before === 'string') {
			const at = Date.parse(part.before);
			if (!Number.isNaN(at)) checks.push((m) => m.receivedAt < at);
		}
	}
	return (meta) => checks.every((check) => check(meta));
}
