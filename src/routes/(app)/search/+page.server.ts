import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { createClient } from '$lib/jmap/auth';
import { searchMail } from '$lib/server/search/hybrid';
import { getDefaultPageSize } from '$lib/server/db/queries/app-prefs';
import { parseSearch } from '$lib/search/parse';
import { buildJmapFilter, type FilterContext } from '$lib/search/build-filter';
import { findLabelsParentId, isLabelMailbox, isLabelsParent } from '$lib/types/labels';

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
	if (!locals.auth) redirect(303, '/login');

	const raw = url.searchParams.get('q')?.trim() ?? '';
	const { page, pageSize } = parsePagination(url, locals.user?.id ?? '');

	const tokens = parseSearch(raw);

	if (!raw) {
		return { raw, tokens, emails: [], total: 0, page, pageSize, totalPages: 1, ranked: false };
	}

	const { mailboxes } = await parent();
	const labelsParentId = findLabelsParentId(mailboxes);
	const ctx: FilterContext = {
		mailboxesByRole: Object.fromEntries(
			mailboxes.filter((m) => m.role).map((m) => [m.role as string, m.id])
		),
		labelsByName: Object.fromEntries(
			mailboxes
				.filter((m) => isLabelMailbox(m, labelsParentId))
				.map((m) => [m.name.toLowerCase(), m.id])
		),
		foldersByName: Object.fromEntries(
			mailboxes
				.filter((m) => !m.role && !isLabelMailbox(m, labelsParentId) && !isLabelsParent(m, labelsParentId))
				.map((m) => [m.name.toLowerCase(), m.id])
		)
	};

	const filter = buildJmapFilter(tokens, ctx);
	if (!filter) {
		return { raw, tokens, emails: [], total: 0, page, pageSize, totalPages: 1, ranked: false };
	}

	const client = createClient(locals.auth);
	const result = await searchMail({
		client,
		accountId: locals.auth.accountId,
		accountRowId: locals.activeAccountId ?? null,
		filter,
		position: (page - 1) * pageSize,
		limit: pageSize
	});

	const totalPages = Math.max(1, Math.ceil(result.total / pageSize));
	if (page > totalPages) {
		const clamped = new URL(url);
		clamped.searchParams.set('page', String(totalPages));
		redirect(303, clamped.pathname + clamped.search);
	}

	return {
		raw,
		tokens,
		emails: result.emails,
		total: result.total,
		page,
		pageSize,
		totalPages,
		ranked: result.ranked
	};
};
