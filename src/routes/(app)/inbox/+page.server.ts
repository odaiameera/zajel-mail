import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { createClient } from '$lib/jmap/auth';
import { countUnreadByCategory, queryAndFetchEmails } from '$lib/jmap/email';
import { userEmailFromAuth } from '$lib/server/user';
import { getDefaultPageSize, getDefaultSort } from '$lib/server/db/queries/app-prefs';
import { getJevSettings } from '$lib/server/db/queries/jev-settings';
import { inboxHoldOn } from '$lib/server/jev/hold';
import { shownCondition } from '$lib/inbox-hold';
import { listMarkedIds } from '$lib/server/db/queries/reminders';
import { allOf, parseListFilter, listFilterCondition } from '$lib/email-filters';
import {
	categoryCondition,
	parseInboxCategory,
	type InboxTabsState
} from '$lib/types/categories';

const ALLOWED_PAGE_SIZES = [10, 25, 50, 100];

function parsePagination(url: URL, userId: string): { page: number; pageSize: number } {
	const defaultSize = getDefaultPageSize(userId);
	const rawSize = parseInt(url.searchParams.get('pageSize') ?? '', 10);
	const pageSize = ALLOWED_PAGE_SIZES.includes(rawSize) ? rawSize : defaultSize;
	const rawPage = parseInt(url.searchParams.get('page') ?? '', 10);
	const page = Number.isFinite(rawPage) && rawPage >= 1 ? rawPage : 1;
	return { page, pageSize };
}

export const load: PageServerLoad = async ({ locals, url, parent }) => {
	if (!locals.auth) {
		redirect(303, '/login');
	}

	const client = createClient(locals.auth);
	const { mailboxes } = await parent();

	const inbox = mailboxes.find((m) => m.role === 'inbox');
	if (!inbox) {
		return {
			emails: [],
			total: 0,
			mailboxId: '',
			page: 1,
			pageSize: 50,
			totalPages: 1,
			remindedIds: [],
			filter: parseListFilter(url.searchParams.get('filter')),
			inboxTabs: null as InboxTabsState | null
		};
	}

	const userEmail = userEmailFromAuth(locals.auth);
	const { page, pageSize } = parsePagination(url, locals.user?.id ?? '');
	const filter = parseListFilter(url.searchParams.get('filter'));

	// With tabs on, the Inbox list is one tab's mail; with them off it is
	// all of it, exactly as before tabs existed.
	const tabsOn = !!locals.activeAccountId && getJevSettings(locals.activeAccountId).inboxTabs;
	const category = tabsOn ? parseInboxCategory(url.searchParams.get('category')) : null;
	// While Jev sorts the tabs, a message it hasn't finished with yet waits
	// (two minutes at most) instead of showing in Important and then moving.
	const hold = tabsOn && inboxHoldOn(locals.activeAccountId) ? shownCondition(Date.now()) : null;

	const [result, tabUnread] = await Promise.all([
		queryAndFetchEmails(client, locals.auth.accountId, inbox.id, {
			position: (page - 1) * pageSize,
			limit: pageSize,
			sort: getDefaultSort(locals.user?.id ?? ''),
			extraFilter: allOf(listFilterCondition(filter), category ? categoryCondition(category) : null, hold)
		}),
		tabsOn ? countUnreadByCategory(client, locals.auth.accountId, inbox.id, hold) : null
	]);

	const totalPages = Math.max(1, Math.ceil(result.total / pageSize));
	if (page > totalPages) {
		const clamped = new URL(url);
		clamped.searchParams.set('page', String(totalPages));
		redirect(303, clamped.pathname + clamped.search);
	}

	const inboxTabs: InboxTabsState | null =
		category && tabUnread ? { active: category, unread: tabUnread } : null;

	return {
		emails: result.emails,
		total: result.total,
		mailboxId: inbox.id,
		page,
		pageSize,
		totalPages,
		remindedIds: listMarkedIds(userEmail),
		filter,
		inboxTabs
	};
};
