import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db/index';
import { setPin } from '$lib/server/db/queries/jev-learning';
import { refreshPipeline } from '$lib/server/mail-pipeline';
import { deleteRule, getRule } from '$lib/server/rules/store';
import { isInboxCategory } from '$lib/types/categories';

/**
 * "Pin <sender> to <tab>" for a rule that only put one sender's mail in an
 * Inbox tab, and was left switched off (`tab_rule`) with the pin it could
 * become. The pin is made, replacing any the sender had, and the rule is
 * deleted: the pin does its work now. Both at once, so a failure leaves the
 * rule where it was.
 */
export const POST: RequestHandler = async ({ params, locals }) => {
	if (!locals.auth || !locals.activeAccountId) return json({ error: 'Not authenticated' }, { status: 401 });
	const accountId = locals.activeAccountId;
	const rule = getRule(accountId, params.id);
	if (!rule) return json({ error: 'Rule not found' }, { status: 404 });
	const pin = rule.note?.tab?.pin;
	if (rule.attention !== 'tab_rule' || !pin || !isInboxCategory(pin.category)) {
		return json({ error: 'This rule can’t be made a sender pin.' }, { status: 400 });
	}
	getDb().transaction(() => {
		setPin(accountId, pin.sender, pin.category);
		deleteRule(accountId, rule.id);
	})();
	refreshPipeline();
	return json({ success: true, pin });
};
