import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createClient, fetchSession } from '$lib/jmap/auth';
import { getMailboxes } from '$lib/jmap/mailbox';
import type { Email } from '$lib/jmap/types';
import { categoryOf, type InboxCategory } from '$lib/types/categories';
import { costUsd, jevMode } from '$lib/server/jev/client';
import { fetchEmailsForJev, judgeEmails, PREVIEW_LIMIT } from '$lib/server/jev/judge';

const FETCH_CHUNK = 50;

/**
 * "Try Jev on my last 200 emails": ask Jev about the active account's
 * newest Inbox mail and report where each would go — without changing
 * anything. Pressing the button is the consent for these emails to be sent;
 * the page says so beside it. Live calls count towards the month's usage.
 */
export const POST: RequestHandler = async ({ locals }) => {
	if (!locals.auth || !locals.activeAccountId) {
		return json({ error: 'Not authenticated' }, { status: 401 });
	}
	if (jevMode() === 'off') {
		return json({ error: 'Jev isn’t configured on this server' }, { status: 409 });
	}
	const account = locals.accounts?.find((a) => a.id === locals.activeAccountId);
	if (!account) return json({ error: 'Unknown account' }, { status: 404 });

	const client = createClient(locals.auth);
	const { accountId } = locals.auth;
	const mailboxes = await getMailboxes(client, accountId);
	const inbox = mailboxes.find((m) => m.role === 'inbox');
	if (!inbox) return json({ error: 'No Inbox on this account' }, { status: 404 });

	const query = await client.request([
		[
			'Email/query',
			{
				accountId,
				filter: { inMailbox: inbox.id },
				sort: [{ property: 'receivedAt', isAscending: false }],
				limit: PREVIEW_LIMIT
			},
			'q'
		]
	]);
	const ids = (query.methodResponses[0][1] as { ids?: string[] }).ids ?? [];

	const emails: Email[] = [];
	for (let i = 0; i < ids.length; i += FETCH_CHUNK) {
		emails.push(...(await fetchEmailsForJev(client, accountId, ids.slice(i, i + FETCH_CHUNK))));
	}

	const judged = await judgeEmails(client, accountId, emails, {
		accountRowId: account.id,
		accountEmail: account.email,
		sentId: mailboxes.find((m) => m.role === 'sent')?.id ?? null,
		session: await fetchSession(locals.auth).catch(() => null)
	});

	const counts: Record<InboxCategory, number> = { important: 0, updates: 0, newsletters: 0, promotions: 0 };
	let inputTokens = 0;
	let failed = 0;
	const rows = judged.map((j) => {
		// Where it would land with sorting on: Jev's pick when confident,
		// otherwise Important.
		const tab: InboxCategory = j.decision?.apply ?? 'important';
		if (j.response) {
			counts[tab]++;
			inputTokens += j.response.usage.inputTokens;
		} else {
			failed++;
		}
		const sender = j.email.from?.[0];
		return {
			id: j.email.id,
			from: sender?.name || sender?.email || '(unknown sender)',
			subject: j.email.subject || '(no subject)',
			receivedAt: j.email.receivedAt,
			current: categoryOf(j.email.keywords),
			pick: j.decision?.category ?? null,
			confidence: j.decision?.confidence ?? null,
			tab: j.response ? tab : null,
			error: j.error
		};
	});

	const mock = judged.some((j) => j.response?.mock);
	return json({
		total: rows.length,
		counts,
		failed,
		inputTokens,
		costUsd: mock ? 0 : costUsd(inputTokens),
		mock,
		rows
	});
};
