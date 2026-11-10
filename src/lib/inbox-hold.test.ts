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
		const window = INBOX_HOLD_MS / 1000;
		for (let s = -window - 3; s <= window + 3; s++) {
			for (const keywords of [{}, { [JEV_SORTED_KEYWORD]: true }] as Record<string, boolean>[]) {
				const email = { keywords, receivedAt: secondsAgo(s) };
				for (const inclusiveAfter of [false, true]) {
					const shown = matches(shownCondition(NOW), email, inclusiveAfter);
					const held = matches(heldCondition(NOW), email, inclusiveAfter);
					expect(shown).toBe(!held);
				}
				// Stalwart's strict `after`, which isHeld follows to the second.
				expect(matches(heldCondition(NOW), email)).toBe(isHeld(email, NOW));
			}
		}
	});

	it('never holds mail dated past the hold window, however far ahead', () => {
		expect(isHeld({ keywords: {}, receivedAt: secondsAgo(-60) }, NOW)).toBe(true);
		expect(isHeld({ keywords: {}, receivedAt: secondsAgo(-(INBOX_HOLD_MS / 1000) - 1) }, NOW)).toBe(false);
		expect(isHeld({ keywords: {}, receivedAt: secondsAgo(-30 * 86_400) }, NOW)).toBe(false);
		const farAhead = { keywords: {}, receivedAt: secondsAgo(-30 * 86_400) };
		expect(matches(heldCondition(NOW), farAhead)).toBe(false);
		expect(matches(shownCondition(NOW), farAhead)).toBe(true);
	});

	it('looks again within one hold at most, whatever the date says', () => {
		expect(holdRecheckDelay(5000)).toBe(6000);
		expect(holdRecheckDelay(-5000)).toBe(1000);
		// 30 days: past setTimeout's 24.8-day limit, which would fire at once.
		expect(holdRecheckDelay(30 * 86_400_000)).toBe(INBOX_HOLD_MS + 1000);
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
