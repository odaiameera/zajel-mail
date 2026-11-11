import { describe, expect, it } from 'vitest';
import {
	heldCondition,
	holdEndsAt,
	holdRecheckDelay,
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

/**
 * Just the JMAP filter conditions the hold uses, evaluated as a server
 * would. RFC 8621 makes `after` inclusive; Stalwart has been seen to treat
 * it as strict, so both are tried.
 */
function matches(filter: Record<string, unknown>, email: Msg, inclusiveAfter = false): boolean {
	const op = filter.operator as string | undefined;
	const conditions = filter.conditions as Record<string, unknown>[] | undefined;
	const each = (c: Record<string, unknown>) => matches(c, email, inclusiveAfter);
	if (op === 'AND') return conditions!.every(each);
	if (op === 'OR') return conditions!.some(each);
	if (op === 'NOT') return !conditions!.some(each);
	const at = Date.parse(email.receivedAt);
	if (typeof filter.hasKeyword === 'string') return !!email.keywords[filter.hasKeyword];
	if (typeof filter.notKeyword === 'string') return !email.keywords[filter.notKeyword];
	if (typeof filter.before === 'string') return at < Date.parse(filter.before);
	if (typeof filter.after === 'string') return inclusiveAfter ? at >= Date.parse(filter.after) : at > Date.parse(filter.after);
	throw new Error(`unexpected condition ${JSON.stringify(filter)}`);
}

const NOW = Date.parse('2026-11-10T10:00:00.400Z');
/** A hold switched on long before any of these messages. */
const LONG_AGO = 0;
const secondsAgo = (s: number) => new Date(Math.floor(NOW / 1000) * 1000 - s * 1000).toISOString().replace('.000Z', 'Z');

describe('the Inbox hold', () => {
	it('holds new mail Jev hasn’t marked, and nothing older than the hold', () => {
		expect(isHeld({ keywords: {}, receivedAt: secondsAgo(5) }, NOW, LONG_AGO)).toBe(true);
		expect(isHeld({ keywords: { [JEV_SORTED_KEYWORD]: true }, receivedAt: secondsAgo(5) }, NOW, LONG_AGO)).toBe(false);
		// Mail from before the hold window, including everything already in
		// the Inbox when this shipped, shows as it always did.
		expect(isHeld({ keywords: {}, receivedAt: secondsAgo(INBOX_HOLD_MS / 1000 + 1) }, NOW, LONG_AGO)).toBe(false);
		expect(isHeld({ keywords: {}, receivedAt: '2020-01-01T00:00:00Z' }, NOW, LONG_AGO)).toBe(false);
	});

	it('lets a message through once the hold is over, whether or not Jev ever answered', () => {
		const email = { keywords: {}, receivedAt: secondsAgo(30) };
		const ends = holdEndsAt(email.receivedAt);
		expect(ends - Date.parse(email.receivedAt)).toBeLessThanOrEqual(INBOX_HOLD_MS + 1);
		expect(isHeld(email, ends - 1, LONG_AGO)).toBe(true);
		expect(isHeld(email, ends, LONG_AGO)).toBe(false);
	});

	it('splits every message one way between the shown and held queries, as isHeld does', () => {
		const window = INBOX_HOLD_MS / 1000;
		for (let s = -window - 3; s <= window + 3; s++) {
			for (const keywords of [{}, { [JEV_SORTED_KEYWORD]: true }] as Record<string, boolean>[]) {
				const email = { keywords, receivedAt: secondsAgo(s) };
				for (const inclusiveAfter of [false, true]) {
					const shown = matches(shownCondition(NOW, LONG_AGO), email, inclusiveAfter);
					const held = matches(heldCondition(NOW, LONG_AGO), email, inclusiveAfter);
					expect(shown).toBe(!held);
				}
				// Stalwart's strict `after`, which isHeld follows to the second.
				expect(matches(heldCondition(NOW, LONG_AGO), email)).toBe(isHeld(email, NOW, LONG_AGO));
			}
		}
	});

	it('never holds mail dated past the hold window, however far ahead', () => {
		expect(isHeld({ keywords: {}, receivedAt: secondsAgo(-60) }, NOW, LONG_AGO)).toBe(true);
		expect(isHeld({ keywords: {}, receivedAt: secondsAgo(-(INBOX_HOLD_MS / 1000) - 1) }, NOW, LONG_AGO)).toBe(false);
		expect(isHeld({ keywords: {}, receivedAt: secondsAgo(-30 * 86_400) }, NOW, LONG_AGO)).toBe(false);
		const farAhead = { keywords: {}, receivedAt: secondsAgo(-30 * 86_400) };
		expect(matches(heldCondition(NOW, LONG_AGO), farAhead)).toBe(false);
		expect(matches(shownCondition(NOW, LONG_AGO), farAhead)).toBe(true);
	});

	it('looks again within one hold at most, whatever the date says', () => {
		expect(holdRecheckDelay(5000)).toBe(6000);
		expect(holdRecheckDelay(-5000)).toBe(1000);
		// 30 days: past setTimeout's 24.8-day limit, which would fire at once.
		expect(holdRecheckDelay(30 * 86_400_000)).toBe(INBOX_HOLD_MS + 1000);
	});

	it('writes whole-second dates, the form the mail server stores', () => {
		const text = JSON.stringify([shownCondition(NOW, LONG_AGO), heldCondition(NOW, LONG_AGO)]);
		expect(text).not.toMatch(/\.\d{3}Z/);
	});

	it('holds only Inbox mail when splitting new mail for notifications', () => {
		const inboxNew = { id: 'a', keywords: {}, receivedAt: secondsAgo(10), mailboxIds: { inbox: true } };
		const inboxSorted = { id: 'b', keywords: { [JEV_SORTED_KEYWORD]: true }, receivedAt: secondsAgo(8), mailboxIds: { inbox: true } };
		const otherFolder = { id: 'c', keywords: {}, receivedAt: secondsAgo(6), mailboxIds: { work: true } };
		const { ready, held, releaseAt } = splitHeld([inboxNew, inboxSorted, otherFolder], 'inbox', NOW, LONG_AGO);
		expect(ready.map((e) => e.id)).toEqual(['b', 'c']);
		expect(held.map((e) => e.id)).toEqual(['a']);
		expect(releaseAt).toBe(holdEndsAt(inboxNew.receivedAt));
		expect(splitHeld([inboxSorted], 'inbox', NOW, LONG_AGO).releaseAt).toBeNull();
	});

	it('never holds mail received before the hold was switched on, to the second', () => {
		const since = Date.parse(secondsAgo(30)) + 400; // switched on 29.6 seconds ago
		expect(isHeld({ keywords: {}, receivedAt: secondsAgo(40) }, NOW, since)).toBe(false);
		// Stamped to the second before the switch: it was showing already.
		expect(isHeld({ keywords: {}, receivedAt: secondsAgo(30) }, NOW, since)).toBe(false);
		expect(isHeld({ keywords: {}, receivedAt: secondsAgo(29) }, NOW, since)).toBe(true);
		const exact = Date.parse(secondsAgo(30));
		expect(isHeld({ keywords: {}, receivedAt: secondsAgo(30) }, NOW, exact)).toBe(true);
		// The queries agree, message by message.
		const window = INBOX_HOLD_MS / 1000;
		for (let s = -3; s <= window + 3; s++) {
			const email = { keywords: {}, receivedAt: secondsAgo(s) };
			for (const inclusiveAfter of [false, true]) {
				expect(matches(shownCondition(NOW, since), email, inclusiveAfter)).toBe(!matches(heldCondition(NOW, since), email, inclusiveAfter));
			}
			expect(matches(heldCondition(NOW, since), email)).toBe(isHeld(email, NOW, since));
		}
		const inbox = { id: 'a', keywords: {}, receivedAt: secondsAgo(40), mailboxIds: { inbox: true } };
		expect(splitHeld([inbox], 'inbox', NOW, since).held).toEqual([]);
	});
});
