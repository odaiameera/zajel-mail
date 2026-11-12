import type { JMAPClient } from '$lib/jmap/client';
import { setEmailCategory } from '$lib/jmap/email';
import type { InboxCategory } from '$lib/types/categories';
import type { SenderPin } from '$lib/server/db/queries/jev-learning';
import { recordCorrections } from '$lib/server/db/queries/jev-decisions';
import { forgetSenderMoves, getPinCategory, recordSenderMoves } from '$lib/server/db/queries/jev-learning';
import { getJevSettings } from '$lib/server/db/queries/jev-settings';
import { normalizeAddress } from '$lib/server/trust-sender';

/**
 * You putting mail in an Inbox tab, whichever way you asked for it: by
 * dragging or "Move to tab" in the app, or by telling the assistant. One
 * function, so every way teaches Jev the same things.
 */

export interface PinSuggestion {
	sender: string;
	category: InboxCategory;
}

/** The sender of each email, lowercased; emails without one are left out. */
async function sendersOf(client: JMAPClient, accountId: string, ids: string[]): Promise<string[]> {
	const response = await client.request([['Email/get', { accountId, ids, properties: ['from'] }, 'g']]);
	const list = (response.methodResponses[0][1] as { list?: { from?: { email?: string }[] | null }[] }).list ?? [];
	return list.map((e) => normalizeAddress(e.from?.[0]?.email ?? '')).filter((a) => a.includes('@'));
}

/**
 * Move messages to a tab (keywords only, so they stay where they are) and
 * remember that you did. `accountRowId` is the linked account the mail
 * belongs to; without one the move is made and nothing is recorded.
 *
 * `undoOf` says this move takes back an earlier one to that tab.
 *
 * Returns a sender worth offering to pin: every message came from it, the
 * account's Inbox has tabs (so a pin would act), and it isn't pinned to
 * this tab already.
 */
export async function setTab(
	client: JMAPClient,
	accountId: string,
	accountRowId: string | null | undefined,
	ids: string[],
	category: InboxCategory,
	opts: { undoOf?: InboxCategory } = {}
): Promise<PinSuggestion | null> {
	await setEmailCategory(client, accountId, ids, category);
	if (!accountRowId) return null;

	// Your choice of tab: Jev never sorts these again, and where it had
	// sorted any of them, it's how Settings shows how often its picks get
	// corrected.
	recordCorrections(accountRowId, ids, category);
	// And where you move each sender's mail, which Jev is told next time.
	// Undo takes its move back out instead of adding one.
	const senders = await sendersOf(client, accountId, ids).catch(() => []);
	if (opts.undoOf) {
		forgetSenderMoves(accountRowId, senders, opts.undoOf);
		return null;
	}
	recordSenderMoves(accountRowId, senders, category);

	// All from one sender: offer to pin it, so its mail never has to be
	// moved by hand (or guessed at by Jev) again.
	const unique = [...new Set(senders)];
	return unique.length === 1 &&
		getJevSettings(accountRowId).inboxTabs &&
		getPinCategory(accountRowId, unique[0]) !== category
		? { sender: unique[0], category }
		: null;
}

export interface TabChoice {
	/** The tab to put the message in, or null to leave its tab as it is. */
	tab: InboxCategory | null;
	/** The pin that chose it, when one did. */
	pin: SenderPin | null;
	/** Whether Jev's own pick would be used: the message is still in Important and nothing of yours decides it. */
	open: boolean;
}

/**
 * The tab for one Inbox message, in order: nothing while the Inbox has no
 * tabs; your own earlier choice stands (Important included, which leaves no
 * keyword to see it by); then a sender pin; then Jev's confident pick;
 * otherwise it stays where it is. Neither a pin nor Jev overrules a tab the
 * message already has, except that a message already in its pin's tab is
 * still the pin's doing (an earlier pass put it there without reaching Jev
 * for the rest), so the record says so.
 */
export function decideTab(input: {
	tabsOn: boolean;
	userChose: boolean;
	currentTab: InboxCategory;
	pin: SenderPin | null;
	/** Jev's confident pick, or null. */
	jevPick: InboxCategory | null;
}): TabChoice {
	const { tabsOn, userChose, currentTab, pin, jevPick } = input;
	const free = tabsOn && !userChose;
	const open = free && currentTab === 'important';
	const pinned = pin && free && (open || currentTab === pin.category) ? pin : null;
	return { tab: pinned ? pinned.category : open ? jevPick : null, pin: pinned, open: open && !pinned };
}
