import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listRules, reorderRules } from '$lib/server/rules/store';
import { refreshPipeline } from '$lib/server/mail-pipeline';

/**
 * Put the active account's rules in a new order: `{ ids }`, every one of
 * its rule ids exactly once. A list from a page that is out of date (a rule
 * added or deleted elsewhere since) is refused rather than guessed at.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.auth || !locals.activeAccountId) return json({ error: 'Not authenticated' }, { status: 401 });
	const body = (await request.json().catch(() => ({}))) as { ids?: unknown };
	const ids = body.ids;
	if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) {
		return json({ error: 'ids must be a list of rule ids' }, { status: 400 });
	}
	if (!reorderRules(locals.activeAccountId, ids)) {
		return json({ error: 'The rules have changed since this page loaded. Reload and try again.' }, { status: 409 });
	}
	refreshPipeline();
	return json({ rules: listRules(locals.activeAccountId) });
};
