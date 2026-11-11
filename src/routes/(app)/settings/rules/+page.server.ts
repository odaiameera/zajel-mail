import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent }) => {
	const { rules, labels, mailboxes } = await parent();
	return {
		rules: rules ?? [],
		labels: labels ?? [],
		mailboxes: mailboxes ?? []
	};
};
