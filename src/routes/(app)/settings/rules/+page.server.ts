import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/** Folders, labels and rules have one page now. */
export const load: PageServerLoad = () => {
	redirect(308, '/settings/folders-labels');
};
