import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createClient } from '$lib/jmap/auth';
import { getMailboxes } from '$lib/jmap/mailbox';
import { parseRule } from '$lib/server/rules/schema';
import { deleteRule, getRule, updateRule } from '$lib/server/rules/store';
import { needsRewrite, type RuleDraft } from '$lib/types/rules';

/**
 * One rule of the active account. PATCH edits it: what is sent replaces
 * those fields (`{ enabled }` alone switches it on or off) and the result
 * goes through `parseRule`, like a new rule.
 *
 * A rule an upgrade switched off for good (its Jev condition is gone, say)
 * comes back on only as a whole rule, conditions and target as its owner
 * has now written them: "Save as exact rule". Switching it on as it stands
 * is refused, since what is left of it would match more mail than it was
 * written for.
 */

export const PATCH: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.auth || !locals.activeAccountId) return json({ error: 'Not authenticated' }, { status: 401 });
	const existing = getRule(locals.activeAccountId, params.id);
	if (!existing) return json({ error: 'Rule not found' }, { status: 404 });

	const body = await request.json().catch(() => null);
	const sent = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
	const current: RuleDraft = {
		name: existing.name,
		enabled: existing.enabled,
		logic: existing.logic,
		conditions: existing.conditions,
		target: existing.target,
		markRead: existing.markRead,
		star: existing.star,
		stop: existing.stop
	};
	const merged = { ...current, ...sent };
	if (needsRewrite(existing) && merged.enabled === true && (!('conditions' in sent) || !('target' in sent))) {
		return json(
			{ error: 'Rewrite this rule with exact conditions and save it before switching it on.' },
			{ status: 400 }
		);
	}

	const mailboxes = await getMailboxes(createClient(locals.auth), locals.auth.accountId);
	const { rule, problems } = parseRule(merged, mailboxes);
	if (problems.length > 0) return json({ error: problems[0].message, problems }, { status: 400 });
	return json({ rule: updateRule(locals.activeAccountId, params.id, rule) });
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.auth || !locals.activeAccountId) return json({ error: 'Not authenticated' }, { status: 401 });
	if (!deleteRule(locals.activeAccountId, params.id)) return json({ error: 'Rule not found' }, { status: 404 });
	return json({ success: true });
};
