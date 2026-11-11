import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createClient } from '$lib/jmap/auth';
import { getMailboxes } from '$lib/jmap/mailbox';
import { rulesNeedBody } from '$lib/server/rules/engine';
import { scanInbox } from '$lib/server/rules/scan';
import { parseRule } from '$lib/server/rules/schema';
import type { Rule } from '$lib/types/rules';

/** How far back a preview looks: the newest Inbox messages, fewer when bodies are fetched. */
const LIMIT = 500;
const LIMIT_WITH_BODY = 200;

/**
 * How many Inbox messages the rule being edited matches, counted by the
 * same scan "Save & apply" runs, only without writing. The draft is not
 * saved yet, so it goes through `parseRule` as a save would, and what is
 * wrong with it comes back as `problems` for the editor to show. Only the
 * conditions decide the count: a draft with no target yet is still
 * counted, one whose conditions don't hold up counts nothing. Debounce the
 * caller (~400ms): every keystroke in the editor fires this.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.auth || !locals.activeAccountId) return json({ error: 'Not authenticated' }, { status: 401 });

	const { rule: draft } = (await request.json().catch(() => ({}))) as { rule?: unknown };
	if (!draft || typeof draft !== 'object') return json({ error: 'rule required' }, { status: 400 });

	try {
		const client = createClient(locals.auth);
		const mailboxes = await getMailboxes(client, locals.auth.accountId);
		const { rule, problems } = parseRule(draft, mailboxes);
		const said = problems.length > 0 ? { problems } : {};
		if (problems.some((p) => p.field === 'conditions' || p.field === 'logic')) {
			return json({ matched: 0, scanned: 0, total: 0, ...said });
		}
		// A rule is often edited switched off; the count is what it would match switched on.
		const candidate: Rule = { ...rule, enabled: true, id: 'preview', position: 0, createdAt: 0, updatedAt: 0 };
		const { matched, scanned, total } = await scanInbox(client, locals.auth.accountId, [candidate], {
			apply: false,
			mailboxes,
			limit: rulesNeedBody([candidate]) ? LIMIT_WITH_BODY : LIMIT
		});
		return json({ matched, scanned, total, ...said });
	} catch (err) {
		return json({ error: err instanceof Error ? err.message : 'Preview failed' }, { status: 500 });
	}
};
