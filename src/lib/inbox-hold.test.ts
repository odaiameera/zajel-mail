import { describe, expect, it } from 'vitest';
import {
	heldCondition,
	holdEndsAt,
	INBOX_HOLD_MS,
	isHeld,
	JEV_SORTED_KEYWORD,
	shownCondition,
	splitHeld
} from './inbox-hold';

interface Msg {
	keywords: Record<string, boolean>;
	receivedAt: string;
	mailboxIds?: Record<string, boolean>;
}

/** Just the JMAP filter conditions the hold uses, evaluated as a server would. */
function matches(filter: Record<string, unknown>, email: Msg): boolean {
	const op = filter.operator as string | undefined;
	const conditions = filter.conditions as Record<string, unknown>[] | undefined;
	if (op === 'AND') return conditions!.every((c) => matches(c, email));
	if (op === 'OR') return conditions!.some((c) => matches(c, email));
	if (op === 'NOT') return !conditions!.some((c) => matches(c, email));
	const at = Date.parse(email.receivedAt);
	if (typeof filter.hasKeyword === 'string') return !!email.keywords[filter.hasKeyword];
	if (typeof filter.notKeyword === 'string') return !email.keywords[filter.notKeyword];
	if (typeof filter.before === 'string') return at < Date.parse(filter.before);
	if (typeof filter.after === 'string') return at > Date.parse(filter.after);
	throw new Error(`unexpected condition ${JSON.stringify(filter)}`);
}

const NOW = Date.parse('2026-11-10T10:00:00.400Z');
const secondsAgo = (s: number) => new Date(Math.floor(NOW / 1000) * 1000 - s * 1000).toISOString().replace('.000Z', 'Z');

describe('the Inbox hold', () => {
	it('holds new mail Jev hasn’t marked, and nothing older than the hold', () => {
		expect(isHeld({ keywords: {}, receivedAt: secondsAgo(5) }, NOW)).toBe(true);
		expect(isHeld({ keywords: { [JEV_SORTED_KEYWORD]: true }, receivedAt: secondsAgo(5) }, NOW)).toBe(false);
		// Mail from before the hold window, including everything already in
		// the Inbox when this shipped, shows as it always did.
		expect(isHeld({ keywords: {}, receivedAt: secondsAgo(INBOX_HOLD_MS / 1000 + 1) }, NOW)).toBe(false);
		expect(isHeld({ keywords: {}, receivedAt: '2020-01-01T00:00:00Z' }, NOW)).toBe(false);
	});

	it('lets a message through once the hold is over, whether or not Jev ever answered', () => {
		const email = { keywords: {}, receivedAt: secondsAgo(30) };
		const ends = holdEndsAt(email.receivedAt);
		expect(ends - Date.parse(email.receivedAt)).toBeLessThanOrEqual(INBOX_HOLD_MS + 1);
		expect(isHeld(email, ends - 1)).toBe(true);
		expect(isHeld(email, ends)).toBe(false);
	});

	it('splits every message one way between the shown and held queries, as isHeld does', () => {
		for (let s = 0; s <= INBOX_HOLD_MS / 1000 + 3; s++) {
			for (const keywords of [{}, { [JEV_SORTED_KEYWORD]: true }]) {
				const email = { keywords, receivedAt: secondsAgo(s) };
				const shown = matches(shownCondition(NOW), email);
				const held = matches(heldCondition(NOW), email);
				expect(shown).toBe(!held);
				expect(held).toBe(isHeld(email, NOW));
			}
		}
	});

	it('writes whole-second dates, the form the mail server stores', () => {
		const text = JSON.stringify([shownCondition(NOW), heldCondition(NOW)]);
		expect(text).not.toMatch(/\.\d{3}Z/);
	});

	it('holds only Inbox mail when splitting new mail for notifications', () => {
		const inboxNew = { id: 'a', keywords: {}, receivedAt: secondsAgo(10), mailboxIds: { inbox: true } };
		const inboxSorted = { id: 'b', keywords: { [JEV_SORTED_KEYWORD]: true }, receivedAt: secondsAgo(8), mailboxIds: { inbox: true } };
		const otherFolder = { id: 'c', keywords: {}, receivedAt: secondsAgo(6), mailboxIds: { work: true } };
		const { ready, held, releaseAt } = splitHeld([inboxNew, inboxSorted, otherFolder], 'inbox', NOW);
		expect(ready.map((e) => e.id)).toEqual(['b', 'c']);
		expect(held.map((e) => e.id)).toEqual(['a']);
		expect(releaseAt).toBe(holdEndsAt(inboxNew.receivedAt));
		expect(splitHeld([inboxSorted], 'inbox', NOW).releaseAt).toBeNull();
	});
});
