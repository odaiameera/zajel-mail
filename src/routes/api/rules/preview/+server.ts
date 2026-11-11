import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createClient } from '$lib/jmap/auth';
import { rulesNeedBody } from '$lib/server/rules/engine';
import { scanInbox } from '$lib/server/rules/scan';
import { upgradeRules } from '$lib/server/rules/upgrade';
import { isRunnable, needsRewrite, type ActionRule } from '$lib/types/rules';

/** How far back a preview looks: the newest Inbox messages, fewer when bodies are fetched. */
const LIMIT = 500;
const LIMIT_WITH_BODY = 200;

/**
 * How many Inbox messages the rule being edited matches, counted by the
 * same scan "Save & apply" runs, only without writing. The rule is not
 * saved yet, so it first gets the guard a saved rule gets: the save-time
 * conversion (given no sender pins, so it writes nothing) and the check
 * that it may run at all. Debounce the caller (~400ms): every keystroke in
 * the editor fires this.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.auth) return json({ error: 'Not authenticated' }, { status: 401 });

	const { rule } = (await request.json()) as { rule: ActionRule };
	if (!rule || typeof rule !== 'object') return json({ error: 'rule required' }, { status: 400 });

	const [upgraded] = upgradeRules([rule], null);
	// A rule is often edited switched off; the count is what it would match
	// switched on. A rule waiting to be rewritten counts nothing.
	const candidate = { ...upgraded, enabled: true };
	if (needsRewrite(upgraded) || !isRunnable(candidate)) return json({ matched: 0, scanned: 0, total: 0 });

	try {
		const client = createClient(locals.auth);
		const { matched, scanned, total } = await scanInbox(client, locals.auth.accountId, [candidate], {
			apply: false,
			limit: rulesNeedBody([candidate]) ? LIMIT_WITH_BODY : LIMIT
		});
		return json({ matched, scanned, total });
	} catch (err) {
		return json({ error: err instanceof Error ? err.message : 'Preview failed' }, { status: 500 });
	}
};
