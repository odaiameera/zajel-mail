/**
 * The Inbox's short hold on new mail while Jev sorts it.
 *
 * With tabs on and Jev reading an account's mail, a message that has just
 * arrived would otherwise show in Important for the few seconds (or, if
 * the fast path is down, the minute) until Jev puts it in Updates,
 * Newsletters or Promotions, then jump. Instead the Inbox tabs, their
 * unread counts, the Inbox's unread badge and new-mail notifications leave
 * a new message out until Jev has finished with it, which it marks with
 * JEV_SORTED_KEYWORD, whatever the outcome — "stays in Important" included.
 *
 * The hold is only ever this short: a message older than INBOX_HOLD_MS
 * shows whether Jev got to it or not, so an unreachable, slow, rate-limited
 * or switched-off Jev can delay mail by at most that long and never hide
 * it. Mail from before the hold window is never held, so nothing already
 * in the Inbox disappears. Search, All Mail and every other view show held
 * mail as usual; only the Inbox tabs wait.
 *
 * Stalwart stamps receivedAt to the second, so the boundary is a whole
 * second and "held" and "shown" split every message exactly one way.
 */

/** Set on a message once Jev is done with it. Lowercase and `$`-prefixed, like the tab keywords. */
export const JEV_SORTED_KEYWORD = '$jev_sorted';

/**
 * Two minutes: Jev answers within seconds of delivery, and if that fast path
 * is down the once-a-minute run still gets there in time, with room for one
 * slow call. Past this, a message shows in Important whatever Jev is doing.
 */
export const INBOX_HOLD_MS = 2 * 60_000;

/** The earliest receivedAt still held at `now`, in ms: a whole second. */
export function holdBoundary(now: number): number {
	return Math.ceil((now - INBOX_HOLD_MS) / 1000) * 1000;
}

/** JMAP UTCDate without milliseconds, the form Stalwart stores. */
function utcDate(ms: number): string {
	return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Email/query condition for Inbox mail the hold lets through at `now` (AND it with the Inbox). */
export function shownCondition(now: number): Record<string, unknown> {
	return {
		operator: 'OR',
		conditions: [{ hasKeyword: JEV_SORTED_KEYWORD }, { before: utcDate(holdBoundary(now)) }]
	};
}

/** Email/query condition for Inbox mail still held at `now`: the exact complement of shownCondition. */
export function heldCondition(now: number): Record<string, unknown> {
	return {
		operator: 'AND',
		conditions: [{ notKeyword: JEV_SORTED_KEYWORD }, { after: utcDate(holdBoundary(now) - 1000) }]
	};
}

interface HoldFields {
	keywords?: Record<string, boolean> | null;
	receivedAt: string;
}

/** Whether a message in the Inbox is still held at `now`. */
export function isHeld(email: HoldFields, now: number): boolean {
	if (email.keywords?.[JEV_SORTED_KEYWORD]) return false;
	return Date.parse(email.receivedAt) >= holdBoundary(now);
}

/** When a message received at `receivedAt` stops being held, if Jev never marks it. */
export function holdEndsAt(receivedAt: string): number {
	return Date.parse(receivedAt) + INBOX_HOLD_MS + 1;
}

/**
 * Split new mail into what can be announced now and what the Inbox is still
 * holding, with when the first held message is let through. Only mail in
 * the Inbox is held: Jev sorts nothing else.
 */
export function splitHeld<T extends HoldFields & { mailboxIds?: Record<string, boolean> | null }>(
	list: T[],
	inboxId: string | null,
	now: number
): { ready: T[]; held: T[]; releaseAt: number | null } {
	const ready: T[] = [];
	const held: T[] = [];
	for (const email of list) {
		if (inboxId && email.mailboxIds?.[inboxId] && isHeld(email, now)) held.push(email);
		else ready.push(email);
	}
	const releaseAt = held.length ? Math.min(...held.map((e) => holdEndsAt(e.receivedAt))) : null;
	return { ready, held, releaseAt };
}
