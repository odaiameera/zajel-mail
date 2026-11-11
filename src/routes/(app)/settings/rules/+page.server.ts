import type { PageServerLoad } from './$types';
import { listRules } from '$lib/server/rules/store';
import type { ActionRule, Rule, RuleAction } from '$lib/types/rules';

/** A stopgap until the page is rebuilt on rules that file into one place: each rule, read as a list of actions. */
function toActionRule(rule: Rule): ActionRule {
	const actions: RuleAction[] = [];
	const t = rule.target;
	if (t.kind === 'folder') actions.push({ type: 'moveToFolder', value: t.mailboxId });
	if (t.kind === 'label') actions.push({ type: 'applyLabel', value: t.mailboxId });
	if (t.kind === 'trash') actions.push({ type: 'delete' });
	if (rule.markRead) actions.push({ type: 'markRead' });
	if (rule.star) actions.push({ type: 'markImportant' });
	if (rule.stop) actions.push({ type: 'stopProcessing' });
	return {
		id: rule.id,
		name: rule.name,
		enabled: rule.enabled,
		logic: rule.logic,
		conditions: rule.conditions,
		actions,
		createdAt: rule.createdAt,
		...(rule.attention && rule.attention !== 'split' ? { attention: rule.attention } : {}),
		...(rule.legacy ? { legacy: rule.legacy } : {}),
		...(rule.note?.tab ? { tabNote: rule.note.tab } : {})
	};
}

/** The rules are read here, for this page only, not by the app layout on every navigation. */
export const load: PageServerLoad = async ({ parent, locals }) => {
	const { labels, mailboxes } = await parent();
	return {
		rules: locals.activeAccountId ? listRules(locals.activeAccountId).map(toActionRule) : [],
		labels: labels ?? [],
		mailboxes: mailboxes ?? []
	};
};
