import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createClient } from '$lib/jmap/auth';
import { getMailboxes } from '$lib/jmap/mailbox';
import { MAX_NAME, parseRule } from '$lib/server/rules/schema';
import { deleteRule, getRule, setRuleBasics, updateRule } from '$lib/server/rules/store';
import { needsRewrite, type RuleDraft, type RuleProblem } from '$lib/types/rules';

/**
 * One rule of the active account. PATCH edits it, in one of two ways.
 *
 * - A small edit sends only `enabled` and/or `name`. Only those are checked
 *   and saved: the rule's conditions and target are left as stored, so a
 *   rule an upgrade carried over (one a new rule like it would be refused
 *   for: 21 conditions, a folder since deleted) can still be switched off,
 *   renamed, or switched back on.
 * - Anything else (`logic`, `conditions`, `target`, `markRead`, `star`,
 *   `stop`) is a full edit: what is sent replaces those fields and the
 *   result goes through `parseRule`, like a new rule.
 *
 * A rule an upgrade switched off for good (its Jev condition is gone, say)
 * comes back on only through a full edit sent with `rewrite: true`, as its
 * owner has now written it: "Save as exact rule". Any other edit of it is
 * saved but leaves it flagged and off, and asking to switch it on without
 * `rewrite` is refused: what is left of it would match more mail than it
 * was written for.
 */

const FULL_EDIT_FIELDS = ['logic', 'conditions', 'target', 'markRead', 'star', 'stop'] as const;
const SWITCH_ON_REFUSED = 'Rewrite this rule with exact conditions and press “Save as exact rule” to switch it back on.';

const refuse = (problems: RuleProblem[]) => json({ error: problems[0].message, problems }, { status: 400 });

export const PATCH: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.auth || !locals.activeAccountId) return json({ error: 'Not authenticated' }, { status: 401 });
	const existing = getRule(locals.activeAccountId, params.id);
	if (!existing) return json({ error: 'Rule not found' }, { status: 404 });

	const body = await request.json().catch(() => null);
	const sent = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
	const flagged = needsRewrite(existing);
	const rewrite = sent.rewrite === true;
	const fullEdit = FULL_EDIT_FIELDS.some((field) => field in sent);

	if (!fullEdit) {
		if (rewrite) {
			return json({ error: 'Send the whole rule, as you have rewritten it, to save it as an exact rule.' }, { status: 400 });
		}
		const change: { name?: string; enabled?: boolean } = {};
		if ('name' in sent) {
			const name = typeof sent.name === 'string' ? sent.name.trim() : '';
			if (name === '') return refuse([{ field: 'name', message: 'Give the rule a name.' }]);
			if (name.length > MAX_NAME) return refuse([{ field: 'name', message: `Keep the name to ${MAX_NAME} characters or fewer.` }]);
			change.name = name;
		}
		if ('enabled' in sent) {
			if (typeof sent.enabled !== 'boolean') return json({ error: 'Say whether the rule is on or off.' }, { status: 400 });
			if (flagged && sent.enabled) return json({ error: SWITCH_ON_REFUSED }, { status: 400 });
			change.enabled = sent.enabled;
		}
		return json({ rule: setRuleBasics(locals.activeAccountId, params.id, change) });
	}

	if (flagged && !rewrite && sent.enabled === true) return json({ error: SWITCH_ON_REFUSED }, { status: 400 });

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
	const mailboxes = await getMailboxes(createClient(locals.auth), locals.auth.accountId);
	const { rule, problems } = parseRule({ ...current, ...sent }, mailboxes);
	if (problems.length > 0) return refuse(problems);
	return json({ rule: updateRule(locals.activeAccountId, params.id, rule, { rewrite }) });
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.auth || !locals.activeAccountId) return json({ error: 'Not authenticated' }, { status: 401 });
	if (!deleteRule(locals.activeAccountId, params.id)) return json({ error: 'Rule not found' }, { status: 404 });
	return json({ success: true });
};
