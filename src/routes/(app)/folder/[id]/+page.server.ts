import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { createClient } from '$lib/jmap/auth';
import { queryAndFetchEmails } from '$lib/jmap/email';
import { mailboxDisplayName } from '$lib/utils/mailbox-display';
import { userEmailFromAuth } from '$lib/server/user';
import { getDefaultPageSize, getDefaultSort } from '$lib/server/db/queries/app-prefs';
import { listMarkedIds, listReminders } from '$lib/server/db/queries/reminders';
import { listScheduledSends } from '$lib/server/db/queries/scheduled-sends';
import { isScheduledMailbox } from '$lib/jmap/mailbox';
import { parseListFilter, listFilterCondition } from '$lib/email-filters';

const ALLOWED_PAGE_SIZES = [10, 25, 50, 100];

function parsePagination(url: URL, userId: string): { page: number; pageSize: number } {
	const defaultSize = getDefaultPageSize(userId);
	const rawSize = parseInt(url.searchParams.get('pageSize') ?? '', 10);
	const pageSize = ALLOWED_PAGE_SIZES.includes(rawSize) ? rawSize : defaultSize;
	const rawPage = parseInt(url.searchParams.get('page') ?? '', 10);
	const page = Number.isFinite(rawPage) && rawPage >= 1 ? rawPage : 1;
	return { page, pageSize };
}

export const load: PageServerLoad = async ({ locals, url, params, parent }) => {
	if (!locals.auth) {
		redirect(303, '/login');
	}

	const client = createClient(locals.auth);
	const { mailboxes, labels } = await parent();

	const mailbox = mailboxes.find((m) => m.id === params.id);
	if (!mailbox) {
		return {
			emails: [],
			total: 0,
			mailboxName: 'Unknown',
			mailboxId: params.id,
			unreadCount: 0,
			page: 1,
			pageSize: 50,
			totalPages: 1,
			remindedIds: [],
			reminders: [],
			scheduled: [],
			filter: parseListFilter(url.searchParams.get('filter'))
		};
	}

	const userEmail = userEmailFromAuth(locals.auth);
	const { page, pageSize } = parsePagination(url, locals.user?.id ?? '');
	const filter = parseListFilter(url.searchParams.get('filter'));

	const result = await queryAndFetchEmails(client, locals.auth.accountId, mailbox.id, {
		position: (page - 1) * pageSize,
		limit: pageSize,
		sort: getDefaultSort(locals.user?.id ?? ''),
		extraFilter: listFilterCondition(filter)
	});

	const totalPages = Math.max(1, Math.ceil(result.total / pageSize));
	if (page > totalPages) {
		const clamped = new URL(url);
		clamped.searchParams.set('page', String(totalPages));
		redirect(303, clamped.pathname + clamped.search);
	}

	const reminders = listReminders(userEmail).map((r) => ({
		emailId: r.jmap_email_id,
		remindAt: r.remind_at,
		originalMailboxId: r.original_mailbox_id
	}));

	// When each message in Scheduled goes out, or that it didn't.
	const scheduled =
		isScheduledMailbox(mailbox) && locals.activeAccountId
			? listScheduledSends(locals.activeAccountId).map((r) => ({
					emailId: r.jmap_email_id,
					sendAt: r.send_at,
					status: r.status,
					error: r.last_error
				}))
			: [];

	return {
		emails: result.emails,
		total: result.total,
		mailboxName: mailboxDisplayName(mailbox, labels),
		mailboxId: mailbox.id,
		unreadCount: mailbox.unreadEmails,
		page,
		pageSize,
		totalPages,
		remindedIds: listMarkedIds(userEmail),
		reminders,
		scheduled,
		filter
	};
};
