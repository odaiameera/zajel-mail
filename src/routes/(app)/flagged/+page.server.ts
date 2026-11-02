import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { createClient } from '$lib/jmap/auth';
import { queryAndFetchEmailsWithFilter } from '$lib/jmap/email';
import { userEmailFromAuth } from '$lib/server/user';
import { getDefaultPageSize, getDefaultSort } from '$lib/server/db/queries/app-prefs';
import { listMarkedIds, listReminders } from '$lib/server/db/queries/reminders';

const ALLOWED_PAGE_SIZES = [10, 25, 50, 100];

function parsePagination(url: URL, userId: string): { page: number; pageSize: number } {
	const defaultSize = getDefaultPageSize(userId);
	const rawSize = parseInt(url.searchParams.get('pageSize') ?? '', 10);
	const pageSize = ALLOWED_PAGE_SIZES.includes(rawSize) ? rawSize : defaultSize;
	const rawPage = parseInt(url.searchParams.get('page') ?? '', 10);
	const page = Number.isFinite(rawPage) && rawPage >= 1 ? rawPage : 1;
	return { page, pageSize };
}

/**
 * Flagged view: every $flagged message across all folders (Gmail "Starred"
 * semantics), excluding trash and junk.
 */
export const load: PageServerLoad = async ({ locals, url, parent }) => {
	if (!locals.auth) redirect(303, '/login');

	const userEmail = userEmailFromAuth(locals.auth);
	const { page, pageSize } = parsePagination(url, locals.user?.id ?? '');

	const { mailboxes } = await parent();
	const conditions: Record<string, unknown>[] = [{ hasKeyword: '$flagged' }];
	for (const role of ['trash', 'junk']) {
		const mb = mailboxes.find((m) => m.role === role);
		if (mb) conditions.push({ operator: 'NOT', conditions: [{ inMailbox: mb.id }] });
	}
	const filter = { operator: 'AND', conditions };

	const client = createClient(locals.auth);
	const result = await queryAndFetchEmailsWithFilter(client, locals.auth.accountId, filter, {
		position: (page - 1) * pageSize,
		limit: pageSize,
		sort: getDefaultSort(locals.user?.id ?? '')
	});

	const totalPages = Math.max(1, Math.ceil(result.total / pageSize));
	if (page > totalPages) {
		const clamped = new URL(url);
		clamped.searchParams.set('page', String(totalPages));
		redirect(303, clamped.pathname + clamped.search);
	}

	return {
		emails: result.emails,
		total: result.total,
		page,
		pageSize,
		totalPages,
		remindedIds: listMarkedIds(userEmail),
		reminders: listReminders(userEmail).map((r) => ({
			emailId: r.jmap_email_id,
			remindAt: r.remind_at,
			originalMailboxId: r.original_mailbox_id
		}))
	};
};
