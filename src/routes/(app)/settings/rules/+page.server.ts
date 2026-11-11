import type { PageServerLoad } from './$types';
import { listRules } from '$lib/server/rules/store';

/** The rules are read here, for this page only, not by the app layout on every navigation. */
export const load: PageServerLoad = async ({ parent, locals }) => {
	const { labels, mailboxes } = await parent();
	return {
		rules: locals.activeAccountId ? listRules(locals.activeAccountId) : [],
		labels: labels ?? [],
		mailboxes: mailboxes ?? []
	};
};
