import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// Auto-reply was a Sieve vacation message, which this mail server never
// sent, so the page is out of the menu until the app sends replies itself.
// The redirect is temporary (307), not permanent: a browser would remember
// a permanent one and never show the page again once it is back.
export const load: PageServerLoad = () => {
	redirect(307, '/settings');
};
