import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createClient } from '$lib/jmap/auth';
import { getMailboxes } from '$lib/jmap/mailbox';
import { parseRule } from '$lib/server/rules/schema';
import { createRule, listRules } from '$lib/server/rules/store';
import { refreshPipeline } from '$lib/server/mail-pipeline';

/**
 * The active account's rules: GET lists them in the order they run, POST
 * adds one at the end. Rules are saved one at a time, each through
 * `parseRule`; nothing takes a whole list from the browser any more.
 */

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.auth || !locals.activeAccountId) return json({ error: 'Not authenticated' }, { status: 401 });
	return json({ rules: listRules(locals.activeAccountId) });
};

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.auth || !locals.activeAccountId) return json({ error: 'Not authenticated' }, { status: 401 });
	const body = await request.json().catch(() => null);
	const mailboxes = await getMailboxes(createClient(locals.auth), locals.auth.accountId);
	const { rule, problems } = parseRule(body, mailboxes);
	if (problems.length > 0) return json({ error: problems[0].message, problems }, { status: 400 });
	const created = createRule(locals.activeAccountId, rule);
	// New mail now has something to act on it: an event stream, and maybe the Inbox's hold.
	refreshPipeline();
	return json({ rule: created });
};
