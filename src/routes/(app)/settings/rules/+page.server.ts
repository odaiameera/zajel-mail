import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/** Folders, labels and rules have one page now; the list of all rules is its #rules section. */
export const load: PageServerLoad = () => {
	redirect(308, '/settings/folders-labels#rules');
};
