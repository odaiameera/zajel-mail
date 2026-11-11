import type { PageServerLoad } from './$types';
import { listRules } from '$lib/server/rules/store';

/**
 * The rules are read here, for this page only, not by the app layout on
 * every navigation. The folders, labels and their colors and icons come
 * from the layouts.
 */
export const load: PageServerLoad = async ({ parent, locals }) => {
	const { labels, mailboxes, mailboxMeta } = await parent();
	return {
		rules: locals.activeAccountId ? listRules(locals.activeAccountId) : [],
		labels: labels ?? [],
		mailboxes: mailboxes ?? [],
		mailboxMeta: mailboxMeta ?? {}
	};
};
