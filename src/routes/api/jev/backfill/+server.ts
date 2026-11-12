import { json, type RequestEvent } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createClient } from '$lib/jmap/auth';
import type { JMAPClient } from '$lib/jmap/client';
import { getMailboxes } from '$lib/jmap/mailbox';
import { categoryCondition } from '$lib/types/categories';
import { getJevSettings } from '$lib/server/db/queries/jev-settings';
import {
	backfillProgress,
	cancelBackfill,
	enqueueEmails,
	getUsage,
	knownEmailIds
} from '$lib/server/db/queries/jev-decisions';
import { costUsd, jevMode } from '$lib/server/jev/client';

/**
 * Sorting the mail already in the active account's Inbox: what's still
 * unsorted (the Important tab) and what that would cost, progress, start
 * and cancel. The new-mail pipeline does the judging, tab only, on its
 * scheduled passes (see `runBackfill` in jev/backfill.ts). Starting is the
 * consent for that mail to be sent.
 */

/** Tokens per email to estimate with before this account has any usage. */
const ESTIMATE_TOKENS_PER_EMAIL = 1300;
const PAGE = 500;
/** Most emails one start queues. */
const MAX_QUEUE = 20_000;

function ready(accountRowId: string) {
	const settings = getJevSettings(accountRowId);
	return jevMode() !== 'off' && settings.jevEnabled && settings.inboxTabs;
}

/**
 * The Important tab's ids, newest first, that Jev has never seen. The tab
 * alone can't say: mail Jev judged Important stays there, untagged.
 */
async function unsortedIds(client: JMAPClient, accountId: string, account: string): Promise<string[] | null> {
	const inbox = (await getMailboxes(client, accountId)).find((m) => m.role === 'inbox');
	if (!inbox) return null;
	const filter = { operator: 'AND', conditions: [{ inMailbox: inbox.id }, categoryCondition('important')] };
	const ids: string[] = [];
	for (let position = 0; position < MAX_QUEUE; position += PAGE) {
		const res = await client.request([
			[
				'Email/query',
				{ accountId, filter, sort: [{ property: 'receivedAt', isAscending: false }], position, limit: PAGE },
				'q'
			]
		]);
		const page = (res.methodResponses[0][1] as { ids?: string[] }).ids ?? [];
		ids.push(...page);
		if (page.length < PAGE) break;
	}
	const known = knownEmailIds(account, ids);
	return ids.filter((id) => !known.has(id));
}

function auth(event: RequestEvent) {
	const { locals } = event;
	return locals.auth && locals.activeAccountId ? { auth: locals.auth, account: locals.activeAccountId } : null;
}

/** `?progress=1` reads progress alone — what the page polls while a run goes. */
export const GET: RequestHandler = async (event) => {
	const a = auth(event);
	if (!a) return json({ error: 'Not authenticated' }, { status: 401 });
	const progress = backfillProgress(a.account);
	if (event.url.searchParams.has('progress')) return json({ progress });

	const ids = await unsortedIds(createClient(a.auth), a.auth.accountId, a.account);
	const unsorted = ids?.length ?? 0;
	const usage = getUsage(a.account);
	const perEmail = usage.requests > 0 ? Math.round(usage.inputTokens / usage.requests) : ESTIMATE_TOKENS_PER_EMAIL;
	return json({
		ready: ready(a.account),
		mock: jevMode() === 'mock',
		unsorted,
		estimate: { inputTokens: unsorted * perEmail, costUsd: costUsd(unsorted * perEmail) },
		progress
	});
};

export const POST: RequestHandler = async (event) => {
	const a = auth(event);
	if (!a) return json({ error: 'Not authenticated' }, { status: 401 });
	if (!ready(a.account)) {
		return json({ error: 'Turn on Inbox tabs and let Jev read new mail first' }, { status: 409 });
	}
	// Newest first, so the mail you're most likely to look at is sorted first.
	const ids = await unsortedIds(createClient(a.auth), a.auth.accountId, a.account);
	if (!ids) return json({ error: 'No Inbox on this account' }, { status: 404 });
	const queued = enqueueEmails(a.account, ids, Date.now(), true);
	return json({ queued, progress: backfillProgress(a.account) });
};

export const DELETE: RequestHandler = async (event) => {
	const a = auth(event);
	if (!a) return json({ error: 'Not authenticated' }, { status: 401 });
	cancelBackfill(a.account);
	return json({ success: true, progress: backfillProgress(a.account) });
};
