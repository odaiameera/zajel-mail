import type { Mailbox } from '$lib/jmap/types';
import type { Label } from '$lib/types/labels';
import { INBOX_CATEGORIES, isInboxCategory } from '$lib/types/categories';
import type { LegacyRule, Rule, RuleCondition, TabNote } from '$lib/types/rules';

/**
 * What a rule says, in words: for the lists of rules in Settings and the
 * notes beside a rule an upgrade changed. Nothing here decides what a rule
 * does; the rules engine does that.
 */

const FIELD_LABELS: Record<string, string> = { from: 'From', to: 'To', subject: 'Subject', body: 'Body' };
const OP_LABELS: Record<string, string> = {
	contains: 'contains',
	not_contains: 'doesn’t contain',
	is: 'is exactly',
	starts_with: 'starts with',
	ends_with: 'ends with'
};

/** One condition in words, as it reads now or as it read before an upgrade changed it. */
export function conditionText(c: LegacyRule['conditions'][number] | RuleCondition): string {
	const not = c.negate ? 'NOT ' : '';
	const value = (c.value ?? '').trim();
	if (c.field === 'jev') {
		const strictness = 'strictness' in c ? c.strictness : undefined;
		const how = strictness && strictness !== 'normal' ? ` (${strictness})` : '';
		return `${not}Jev judged: “${value}”${how}`;
	}
	if (c.field === 'hasAttachment') return `${not}Has attachment`;
	if (c.field === 'size') return `${not}Size at least ${value} KB`;
	return `${not}${FIELD_LABELS[c.field] ?? c.field} ${OP_LABELS[c.op ?? 'contains'] ?? c.op} “${value}”`;
}

/** "From contains “shop” and Subject contains “receipt”" */
export function conditionsText(rule: Pick<Rule, 'conditions' | 'logic'>): string {
	return rule.conditions.map(conditionText).join(rule.logic === 'anyof' ? ' or ' : ' and ') || 'No conditions';
}

/** Where a rule files mail, in words; "target missing" when the folder or label is gone. */
export function targetText(rule: Rule, mailboxes: Mailbox[], labels: Label[]): string {
	const t = rule.target;
	if (t.kind === 'label') return labels.find((l) => l.id === t.mailboxId)?.name ?? 'target missing';
	if (t.kind === 'folder') return mailboxes.find((m) => m.id === t.mailboxId)?.name ?? 'target missing';
	if (t.kind === 'none') {
		const did = [rule.markRead && 'mark read', rule.star && 'star'].filter(Boolean).join(', ');
		return did || 'nothing';
	}
	const name = { trash: 'Trash', archive: 'Archive', junk: 'Junk' }[t.kind];
	return mailboxes.some((m) => m.role === t.kind) ? name : 'target missing';
}

/** "From contains “shop” → Receipts" */
export function ruleSummary(rule: Rule, mailboxes: Mailbox[], labels: Label[]): string {
	return `${conditionsText(rule)} → ${targetText(rule, mailboxes, labels)}`;
}

/** The Inbox tab a rule used to put mail in, before rules stopped setting tabs: "the Updates tab", or null. */
export function legacyTab(rule: Rule): string | null {
	const tab = (rule.legacy?.actions ?? [])
		.filter((a) => a.type === 'setCategory')
		.map((a) => a.value)
		.filter(isInboxCategory)
		.at(-1);
	const label = INBOX_CATEGORIES.find((c) => c.key === tab)?.label;
	return label ? `the ${label} tab` : null;
}

/** Whether a rule that runs carries a note for its row in the list. */
export function hasRowNote(rule: Rule): boolean {
	return rule.attention === 'tab_removed' || rule.attention === 'split' || !!rule.note?.splitInto;
}

/** A running rule's note, short enough for its row in the list. */
export function rowNote(rule: Rule): string {
	if (rule.attention === 'tab_removed') return `No longer puts mail in ${legacyTab(rule) ?? 'an Inbox tab'}.`;
	return `One of ${rule.note?.splitInto ?? 'several'} rules a rule filing in several places became.`;
}

export const tabName = (key: string | undefined) => INBOX_CATEGORIES.find((c) => c.key === key)?.label ?? 'an Inbox tab';

/** The mail a sender pin acts on, in words: a pin matches a whole address or a whole domain, nothing looser. */
export function pinReach(sender: string): string {
	return sender.startsWith('@')
		? `any address at ${sender.slice(1)} (the part after the @ has to be exactly that, so not its subdomains)`
		: `exactly the address ${sender}`;
}

/** Where a pin and the rule it stands in for differ, for the rule's owner to check. */
export function pinDifference(note: TabNote): string {
	const what = note.pin?.sender.startsWith('@') ? 'that domain' : 'that address';
	if (note.op === 'contains') {
		return `The rule matched any sender containing “${note.said}”; the pin matches only ${what}. Mail it doesn’t match stays in Important.`;
	}
	if (note.op === 'ends_with') {
		return `The rule matched any sender whose address ended with “${note.said}”. The pin matches only ${what}.`;
	}
	if (note.op === 'is') {
		return 'The rule matched this address only when the sender showed no name. The pin matches it with or without one.';
	}
	return '';
}

/** Why the upgrade left a rule that only set a tab switched off instead of making it a pin. */
export function whyNotPinned(note: TabNote | undefined): string {
	switch (note?.why) {
		case 'switched_off':
			return `This rule put mail in ${tabName(note.tab)}. It was switched off, so no pin was made.`;
		case 'after_stop':
			return 'An earlier rule stops processing, so this rule may never have run. No pin was made.';
		case 'pinned_elsewhere':
			return note.kept
				? `${note.kept.sender} is already pinned to ${tabName(note.kept.category)}, which was kept. This rule’s tab (${tabName(note.tab)}) is no longer applied.`
				: 'Rules can’t set a tab any more. This one can’t be turned into a sender pin automatically.';
		case 'no_account':
			return 'No mail account was found for these rules.';
		default:
			return 'Rules can’t set a tab any more. This one can’t be turned into a sender pin automatically.';
	}
}
