import type { JMAPClient } from '$lib/jmap/client';
import { setEmailCategory } from '$lib/jmap/email';
import type { InboxCategory } from '$lib/types/categories';
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
