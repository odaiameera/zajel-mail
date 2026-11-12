import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/** Jev's settings are on the Inbox tabs page now. */
export const load: PageServerLoad = () => {
	redirect(308, '/settings/inbox-tabs');
};
