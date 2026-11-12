/**
 * The Inbox's short hold on new mail while it is sorted into its tab.
 *
 * With tabs on and something sorting an account's new mail (Jev reading
 * it, or sender pins, which act with Jev off too), a message that has just
 * arrived would otherwise show in Important for the few seconds (or, if
 * the fast path is down, the minute) until the sorting pass puts it in
 * Updates, Newsletters or Promotions, then jump. Instead the Inbox tabs,
 * their unread counts, the Inbox's unread badge and new-mail notifications
 * leave a new message out until the pass has finished with it, which it
 * marks with JEV_SORTED_KEYWORD, whatever the outcome — "stays in
 * Important" included. (Which accounts that is, and since when:
 * `inboxHoldSince`, on the server.)
 *
 * The hold is only ever this short: a message older than INBOX_HOLD_MS
 * shows whether the pass got to it or not, so an unreachable, slow,
 * rate-limited or switched-off Jev can delay mail by at most that long and
 * never hide it. Mail from before the hold window is never held, and nor is
 * mail received before the hold was switched on for the account (`since`,
 * kept by the server in `mail_pipeline.hold_since`), so nothing already in
 * the Inbox disappears when a rule or the tabs switch the hold on. Search, All Mail and every other view show held
 * mail as usual; only the Inbox tabs wait.
 *
 * Only mail dated between INBOX_HOLD_MS ago and INBOX_HOLD_MS ahead is
 * held. A message stamped far in the future (an import, an APPEND, a sender
 * or server with a wrong clock) would otherwise wait until that date.
 *
 * Stalwart stamps receivedAt to the second, so both bounds are whole
 * seconds, and "held" is written as NOT "shown" so the two queries split
 * every message exactly one way, however the server reads `before` and
 * `after` at the boundary.
 */

/** Set on a message once the sorting pass is done with it. Lowercase and `$`-prefixed, like the tab keywords. */
export const JEV_SORTED_KEYWORD = '$jev_sorted';

/**
 * Two minutes: Jev answers within seconds of delivery, and if that fast path
 * is down the once-a-minute run still gets there in time, with room for one
 * slow call. Past this, a message shows in Important whatever Jev is doing.
 */
export const INBOX_HOLD_MS = 2 * 60_000;

/**
 * The earliest receivedAt still held at `now`, in ms: a whole second. Never
 * before `since`, when the hold was switched on: mail received earlier was
 * already showing.
 */
export function holdBoundary(now: number, since: number): number {
	return Math.ceil(Math.max(now - INBOX_HOLD_MS, since) / 1000) * 1000;
}

/** The latest receivedAt still held at `now`, in ms: a whole second. */
export function holdCeiling(now: number): number {
	return Math.floor((now + INBOX_HOLD_MS) / 1000) * 1000;
}

/** JMAP UTCDate without milliseconds, the form Stalwart stores. */
function utcDate(ms: number): string {
	return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Dated outside the hold window: older than the hold (or than `since`), or too far ahead. */
function outsideWindow(now: number, since: number): Record<string, unknown>[] {
	return [{ before: utcDate(holdBoundary(now, since)) }, { after: utcDate(holdCeiling(now)) }];
}

/**
 * Email/query condition for Inbox mail the hold lets through at `now` (AND
 * it with the Inbox), for a hold switched on at `since` (ms).
 */
export function shownCondition(now: number, since: number): Record<string, unknown> {
	return { operator: 'OR', conditions: [{ hasKeyword: JEV_SORTED_KEYWORD }, ...outsideWindow(now, since)] };
}

/** Email/query condition for Inbox mail still held at `now`: the exact complement of shownCondition. */
export function heldCondition(now: number, since: number): Record<string, unknown> {
	return {
		operator: 'AND',
		conditions: [{ notKeyword: JEV_SORTED_KEYWORD }, { operator: 'NOT', conditions: outsideWindow(now, since) }]
	};
}

interface HoldFields {
	keywords?: Record<string, boolean> | null;
	receivedAt: string;
}

/** Whether a message in the Inbox is still held at `now`, by a hold switched on at `since` (ms). */
export function isHeld(email: HoldFields, now: number, since: number): boolean {
	if (email.keywords?.[JEV_SORTED_KEYWORD]) return false;
	const at = Date.parse(email.receivedAt);
	return at >= holdBoundary(now, since) && at <= holdCeiling(now);
}

/** When a message received at `receivedAt` stops being held, if Jev never marks it. */
export function holdEndsAt(receivedAt: string): number {
	return Date.parse(receivedAt) + INBOX_HOLD_MS + 1;
}

/**
 * How long to wait before looking again for held mail that is let through
 * `endsIn` ms from now: never longer than a hold, so a wrong date can't
 * set a timer for weeks (or overflow one into firing at once, over and over).
 */
export function holdRecheckDelay(endsIn: number): number {
	return Math.min(Math.max(0, endsIn), INBOX_HOLD_MS) + 1000;
}

/**
 * Split new mail into what can be announced now and what the Inbox is still
 * holding, with when the first held message is let through. Only mail in
 * the Inbox is held: Jev sorts nothing else.
 */
export function splitHeld<T extends HoldFields & { mailboxIds?: Record<string, boolean> | null }>(
	list: T[],
	inboxId: string | null,
	now: number,
	since: number
): { ready: T[]; held: T[]; releaseAt: number | null } {
	const ready: T[] = [];
	const held: T[] = [];
	for (const email of list) {
		if (inboxId && email.mailboxIds?.[inboxId] && isHeld(email, now, since)) held.push(email);
		else ready.push(email);
	}
	const releaseAt = held.length ? Math.min(...held.map((e) => holdEndsAt(e.receivedAt))) : null;
	return { ready, held, releaseAt };
}
