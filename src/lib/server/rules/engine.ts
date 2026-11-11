import type { Email, Mailbox } from '$lib/jmap/types';
import { nextMailboxIds, sameMailboxIds } from '$lib/mailboxes';
import { isRunnable, isUsableCondition, ruleHolds, type Rule, type RuleCondition, type RuleRole } from '$lib/types/rules';

export interface RuleActionCtx {
	inboxId?: string;
	trashId?: string;
	archiveId?: string;
	junkId?: string;
	/**
	 * Live mailbox ids. When provided, label/folder actions whose target no
	 * longer exists are skipped — Stalwart rejects patches referencing dead
	 * mailbox ids and the whole update for that email silently fails.
	 */
	validMailboxIds?: Set<string>;
	/** Every mailbox on the account: a move keeps a message's labels and leaves everything else. */
	mailboxes: RuleMailbox[];
}

type RuleMailbox = Pick<Mailbox, 'id' | 'role' | 'name' | 'parentId'>;

/** Where a rule's targets are on this account: its Inbox, the folders with a role, and every mailbox there is. */
export function ruleContext(mailboxes: RuleMailbox[]): RuleActionCtx {
	const role = (r: string) => mailboxes.find((m) => m.role === r)?.id;
	return {
		inboxId: role('inbox'),
		trashId: role('trash'),
		archiveId: role('archive'),
		junkId: role('junk'),
		validMailboxIds: new Set(mailboxes.map((m) => m.id)),
		mailboxes
	};
}

/** The mailbox a role target files into, if the account has it. */
export function roleMailboxId(ctx: RuleActionCtx, role: RuleRole): string | undefined {
	return role === 'trash' ? ctx.trashId : role === 'archive' ? ctx.archiveId : ctx.junkId;
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

/** Whether a condition matches the email, before NOT is applied. */
function conditionMatches(email: Email, c: RuleCondition, bodyText: string): boolean {
	let res: boolean;

	if (c.field === 'hasAttachment') {
		res = email.hasAttachment === true;
	} else if (c.field === 'size') {
		const kb = parseInt(c.value, 10);
		if (!Number.isFinite(kb)) return false;
		// The same reading as JMAP `minSize`: at least this size.
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

function matchesRule(email: Email, rule: Rule, bodyText: string): boolean {
	return ruleHolds(rule, (c) => conditionMatches(email, c, bodyText));
}

/**
 * Semantic result of running rule actions over one email: the folder it
 * moves to, the labels it gains, and which keywords to flip. Converted to a
 * JMAP update by {@link outcomeToUpdate}, which applies the filing rules of
 * `$lib/mailboxes` to where the message is when it is written.
 */
export interface RuleOutcome {
	/** The folder the message moves to: it leaves every other folder and keeps its labels. */
	moveTo: string | null;
	/** Labels to add. */
	labels: Set<string>;
	keywords: Record<string, boolean>;
	/** Ids of the rules that matched, in order. */
	firedRuleIds: string[];
}

export function emptyOutcome(): RuleOutcome {
	return { moveTo: null, labels: new Set(), keywords: {}, firedRuleIds: [] };
}

/**
 * Evaluate the (enabled, ordered) rules against one email. Labels add up;
 * the first rule that moves the message decides its folder, since a
 * message lives in one; `stop` ends the evaluation. A target that no longer
 * exists is skipped (the next move may then decide). The outcome is
 * idempotent by construction — converting it with {@link outcomeToUpdate}
 * only writes real differences.
 *
 * A rule that may not run is passed over here as well as by the callers
 * that load the rules: one waiting for its owner to rewrite it stays off
 * even if it was switched back on, whichever way the rules got here.
 */
export function evaluateRulesForEmail(
	email: Email,
	enabledRules: Rule[],
	ctx: RuleActionCtx,
	bodyText: string
): RuleOutcome {
	const outcome = emptyOutcome();
	for (const rule of enabledRules) {
		if (!isRunnable(rule) || !matchesRule(email, rule, bodyText)) continue;
		outcome.firedRuleIds.push(rule.id);
		const t = rule.target;
		if (t.kind === 'label') {
			if (targetExists(ctx, t.mailboxId)) outcome.labels.add(t.mailboxId);
		} else if (t.kind !== 'none' && outcome.moveTo === null) {
			const id = t.kind === 'folder' ? t.mailboxId : roleMailboxId(ctx, t.kind);
			if (id && targetExists(ctx, id)) outcome.moveTo = id;
		}
		if (rule.markRead) outcome.keywords['$seen'] = true;
		if (rule.star) outcome.keywords['$flagged'] = true;
		if (rule.stop) break;
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
		const emailUpdate = outcomeToUpdate(email, outcome, ctx.mailboxes);
		if (Object.keys(emailUpdate).length > 0) update[email.id] = emailUpdate;
	}
	return { matched, update };
}

/**
 * Turn an outcome into a JMAP Email/set update object.
 *
 * The move and the labels go through `nextMailboxIds`, the filing rules
 * every caller shares: a move leaves every folder the message is in, not
 * only the Inbox, and keeps its labels.
 *
 * Mailbox membership is written as the **full `mailboxIds` object**, never
 * `mailboxIds/<id>` pointer patches: Stalwart v0.15.0–v0.16.7 (jmap-tools
 * ≤ 0.1.4) tokenizes all-digit pointer segments as array indices and
 * rejects the whole update with "Invalid patch value", and Stalwart's id
 * alphabet produces all-digit mailbox ids ("9", "92", …) for folders
 * created late enough. Keywords keep the pointer form: `$`-prefixed names
 * always tokenize as strings, which every version parses correctly.
 *
 * Returns `{}` when the email already satisfies the outcome.
 */
export function outcomeToUpdate(
	email: Pick<Email, 'mailboxIds' | 'keywords'>,
	outcome: RuleOutcome,
	mailboxes: RuleMailbox[]
): Record<string, unknown> {
	const update: Record<string, unknown> = {};

	let next: Record<string, boolean> = { ...email.mailboxIds };
	if (outcome.moveTo) next = nextMailboxIds(next, { move: outcome.moveTo }, mailboxes) ?? next;
	for (const label of outcome.labels) next = nextMailboxIds(next, { addLabel: label }, mailboxes) ?? next;
	if (!sameMailboxIds(next, email.mailboxIds)) update.mailboxIds = next;

	for (const [keyword, on] of Object.entries(outcome.keywords)) {
		if (!!email.keywords[keyword] !== on) {
			update[`keywords/${keyword}`] = on;
		}
	}

	return update;
}
