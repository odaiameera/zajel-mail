import type { Email } from '$lib/jmap/types';
import {
	effectiveActions,
	isUsableCondition,
	ruleHolds,
	type Rule,
	type RuleCondition
} from '$lib/types/rules';
import { categoryKeywordPatch, isInboxCategory, type InboxCategory } from '$lib/types/categories';

/**
 * Jev's answers for one email, by condition id: the probability it gave the
 * condition's statement. A `jev` condition with no entry is unknown and
 * doesn't hold — the rule can't fire on an answer Jev never gave.
 */
export type JevConditionAnswers = Map<string, number>;

export interface RuleActionCtx {
	inboxId?: string;
	trashId?: string;
	/**
	 * Live mailbox ids. When provided, label/folder actions whose target no
	 * longer exists are skipped — Stalwart rejects patches referencing dead
	 * mailbox ids and the whole update for that email silently fails.
	 */
	validMailboxIds?: Set<string>;
}

function targetExists(ctx: RuleActionCtx, id: string): boolean {
	return !ctx.validMailboxIds || ctx.validMailboxIds.has(id);
}

/** True if any enabled rule needs the message body to evaluate. */
export function rulesNeedBody(rules: Rule[]): boolean {
	return rules.some((r) => r.conditions.some((c) => c.field === 'body' && isUsableCondition(c)));
}

function addressText(addrs: { name: string | null; email: string }[] | null): string {
	if (!addrs) return '';
	return addrs.map((a) => `${a.name ?? ''} ${a.email}`).join(' ');
}

/** Concatenated plain-text body for a fetched email, falling back to preview. */
export function extractBodyText(email: Email): string {
	if (email.bodyValues) {
		const parts = (email.textBody ?? [])
			.map((p) => email.bodyValues?.[p.partId]?.value)
			.filter((v): v is string => !!v);
		if (parts.length) return parts.join(' ');
		const all = Object.values(email.bodyValues)
			.map((v) => v.value)
			.join(' ');
		if (all) return all;
	}
	return email.preview ?? '';
}

/** An exact condition's result before NOT is applied. */
function exactValue(email: Email, c: RuleCondition, bodyText: string): boolean {
	let res: boolean;

	if (c.field === 'hasAttachment') {
		res = email.hasAttachment === true;
	} else if (c.field === 'size') {
		const kb = parseInt(c.value, 10);
		if (!Number.isFinite(kb)) return false;
		// Mirrors the Sieve `size :over` / JMAP `minSize` semantics.
		res = email.size >= kb * 1024;
	} else {
		let hay: string;
		switch (c.field) {
			case 'from': hay = addressText(email.from); break;
			case 'to': hay = addressText(email.to); break;
			case 'subject': hay = email.subject ?? ''; break;
			case 'body': hay = bodyText; break;
			default: return false;
		}
		hay = hay.toLowerCase();
		const needle = c.value.trim().toLowerCase();
		if (!needle) return false;
		switch (c.op) {
			case 'contains': res = hay.includes(needle); break;
			case 'not_contains': res = !hay.includes(needle); break;
			case 'is': res = hay.trim() === needle; break;
			case 'starts_with': res = hay.startsWith(needle); break;
			case 'ends_with': res = hay.endsWith(needle); break;
			default: res = hay.includes(needle);
		}
	}

	return res;
}

/**
 * A condition's raw value for one email: a boolean for an exact condition,
 * Jev's probability for a `jev` one (undefined when it wasn't asked).
 */
export function conditionValue(
	email: Email,
	c: RuleCondition,
	bodyText: string,
	jev?: JevConditionAnswers
): boolean | number | undefined {
	return c.field === 'jev' ? jev?.get(c.id) : exactValue(email, c, bodyText);
}

function matchesRule(email: Email, rule: Rule, bodyText: string, jev?: JevConditionAnswers): boolean {
	return ruleHolds(rule, (c) => conditionValue(email, c, bodyText, jev));
}

/**
 * The `jev` conditions worth asking about for one email: those of rules
 * whose exact conditions leave the outcome open. An all-of rule with a
 * failing exact condition can't match whatever Jev says; an any-of rule
 * with a holding one matches already.
 */
export function jevConditionsToAsk(email: Email, rules: Rule[], bodyText: string): RuleCondition[] {
	const out: RuleCondition[] = [];
	for (const rule of rules) {
		const conds = rule.conditions.filter(isUsableCondition);
		const jevConds = conds.filter((c) => c.field === 'jev');
		if (jevConds.length === 0) continue;
		const exact = conds
			.filter((c) => c.field !== 'jev')
			.map((c) => (c.negate ? !exactValue(email, c, bodyText) : exactValue(email, c, bodyText)));
		if (rule.logic === 'allof' && exact.some((r) => !r)) continue;
		if (rule.logic === 'anyof' && exact.some((r) => r)) continue;
		out.push(...jevConds);
	}
	return out;
}

/**
 * Semantic result of running rule actions over one email — what to add,
 * remove, and which keywords to flip. Converted to a JMAP update by
 * {@link outcomeToUpdate}; keeping this layer semantic (not raw patches)
 * lets the writer choose a wire format every Stalwart version accepts.
 */
export interface RuleOutcome {
	addMailboxIds: Set<string>;
	removeMailboxIds: Set<string>;
	keywords: Record<string, boolean>;
	/** The Inbox tab a rule chose — it overrides Jev's own pick. */
	category?: InboxCategory;
	/** Ids of the rules that matched, in order. */
	firedRuleIds: string[];
}

export function emptyOutcome(): RuleOutcome {
	return { addMailboxIds: new Set(), removeMailboxIds: new Set(), keywords: {}, firedRuleIds: [] };
}

/**
 * Fold one rule's actions into an outcome. Used directly by the manual
 * apply endpoint (which pre-matches emails via Email/query) and via
 * {@link evaluateRulesForEmail} by the scheduler.
 */
export function applyActionsToOutcome(
	email: Email,
	actions: Rule['actions'],
	ctx: RuleActionCtx,
	outcome: RuleOutcome
): { stop: boolean } {
	let stop = false;
	for (const action of actions) {
		switch (action.type) {
			case 'applyLabel':
				if (action.value && targetExists(ctx, action.value)) {
					outcome.addMailboxIds.add(action.value);
				}
				break;
			case 'markRead':
				outcome.keywords['$seen'] = true;
				break;
			case 'markImportant':
				outcome.keywords['$flagged'] = true;
				break;
			case 'setCategory':
				if (isInboxCategory(action.value)) {
					Object.assign(outcome.keywords, categoryKeywordPatch(action.value));
					outcome.category = action.value;
				}
				break;
			case 'moveToFolder':
				if (action.value && targetExists(ctx, action.value)) {
					outcome.addMailboxIds.add(action.value);
					if (ctx.inboxId && action.value !== ctx.inboxId) {
						outcome.removeMailboxIds.add(ctx.inboxId);
					}
				}
				break;
			case 'delete':
				if (ctx.trashId) {
					outcome.addMailboxIds.add(ctx.trashId);
					if (ctx.inboxId) outcome.removeMailboxIds.add(ctx.inboxId);
				}
				break;
			case 'stopProcessing':
				stop = true;
				break;
		}
	}
	return { stop };
}

/**
 * Evaluate the (enabled, ordered) rules against one email. Honors
 * `stopProcessing`. The outcome is idempotent by construction — converting
 * it with {@link outcomeToUpdate} only writes real differences.
 */
export function evaluateRulesForEmail(
	email: Email,
	enabledRules: Rule[],
	ctx: RuleActionCtx,
	bodyText: string,
	jev?: JevConditionAnswers
): RuleOutcome {
	const outcome = emptyOutcome();
	for (const rule of enabledRules) {
		if (!matchesRule(email, rule, bodyText, jev)) continue;
		outcome.firedRuleIds.push(rule.id);
		if (applyActionsToOutcome(email, effectiveActions(rule), ctx, outcome).stop) break;
	}
	return outcome;
}

/**
 * What the matcher reads from each message, with the body only when a rule
 * looks at it. `fetchTextBodyValues` goes on the Email/get call.
 */
export function matcherProperties(rules: Rule[]): { properties: string[]; fetchTextBodyValues: boolean } {
	const needBody = rulesNeedBody(rules);
	return {
		properties: [
			'id', 'receivedAt', 'from', 'to', 'subject', 'size',
			'hasAttachment', 'keywords', 'mailboxIds', 'preview',
			...(needBody ? ['bodyValues', 'textBody'] : [])
		],
		fetchTextBodyValues: needBody
	};
}

/**
 * Run the enabled rules, in order, over fetched messages: how many a rule
 * fired on, and the Email/set update for each one not already as the rules
 * want it. The one matcher behind both delivery-time application and
 * "apply now", so the two act on the same mail.
 */
export function updatesForEmails(
	emails: Email[],
	enabledRules: Rule[],
	ctx: RuleActionCtx
): { matched: number; update: Record<string, Record<string, unknown>> } {
	const needBody = rulesNeedBody(enabledRules);
	let matched = 0;
	const update: Record<string, Record<string, unknown>> = {};
	for (const email of emails) {
		const outcome = evaluateRulesForEmail(email, enabledRules, ctx, needBody ? extractBodyText(email) : '');
		if (outcome.firedRuleIds.length === 0) continue;
		matched++;
		const emailUpdate = outcomeToUpdate(email, outcome);
		if (Object.keys(emailUpdate).length > 0) update[email.id] = emailUpdate;
	}
	return { matched, update };
}

/**
 * Turn an outcome into a JMAP Email/set update object.
 *
 * Mailbox membership is written as the **full `mailboxIds` object**, never
 * `mailboxIds/<id>` pointer patches: Stalwart v0.15.0–v0.16.7 (jmap-tools
 * ≤ 0.1.4) tokenizes all-digit pointer segments as array indices and
 * rejects the whole update with "Invalid patch value" — and Stalwart's id
 * alphabet produces all-digit mailbox ids ("9", "92", …) for folders
 * created late enough. This was the root cause of rules reporting success
 * while folders stayed empty. Keywords keep the pointer form: `$`-prefixed
 * names always tokenize as strings, which every version parses correctly.
 *
 * Returns `{}` when the email already satisfies the outcome.
 */
export function outcomeToUpdate(email: Email, outcome: RuleOutcome): Record<string, unknown> {
	const update: Record<string, unknown> = {};

	if (outcome.addMailboxIds.size > 0 || outcome.removeMailboxIds.size > 0) {
		const next: Record<string, boolean> = { ...email.mailboxIds };
		for (const id of outcome.removeMailboxIds) delete next[id];
		for (const id of outcome.addMailboxIds) next[id] = true;
		// JMAP requires ≥1 mailbox — never strand the message.
		if (Object.keys(next).length === 0) Object.assign(next, email.mailboxIds);

		const changed =
			Object.keys(next).length !== Object.keys(email.mailboxIds).length ||
			Object.keys(next).some((k) => !email.mailboxIds[k]);
		if (changed) update.mailboxIds = next;
	}

	for (const [keyword, on] of Object.entries(outcome.keywords)) {
		if (!!email.keywords[keyword] !== on) {
			update[`keywords/${keyword}`] = on;
		}
	}

	return update;
}
