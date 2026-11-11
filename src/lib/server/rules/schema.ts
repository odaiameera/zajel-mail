import { randomUUID } from 'node:crypto';
import { isScheduledMailbox, REMIND_ME_LATER_NAME } from '$lib/jmap/mailbox';
import type { Mailbox } from '$lib/jmap/types';
import { findLabelsParentId, isLabelMailbox, isLabelsParent, labelMailboxIds } from '$lib/types/labels';
import {
	isUsableCondition,
	RULE_ROLES,
	type RuleCondition,
	type RuleConditionField,
	type RuleConditionOp,
	type RuleDraft,
	type RuleRole,
	type RuleTarget
} from '$lib/types/rules';

/**
 * `parseRule` is the only way a rule enters the store: every create, edit
 * and preview takes what the browser sent through it. It returns the rule
 * as it will be stored, built from the fields it knows (anything else is
 * dropped, `attention`, `note` and `legacy` included: those are the
 * server's), and the problems that stop it being saved, in plain English,
 * each for the part of the editor it is about.
 */

export type RuleProblemField = 'name' | 'logic' | 'conditions' | 'target' | 'actions';

export interface RuleProblem {
	field: RuleProblemField;
	/** For a condition: which one, counted from 0. */
	index?: number;
	message: string;
}

export interface ParsedRule {
	/** The rule as it would be stored. Only to be stored when `problems` is empty. */
	rule: RuleDraft;
	problems: RuleProblem[];
}

export const MAX_NAME = 120;
export const MAX_CONDITIONS = 20;
export const MAX_VALUE = 500;

const FIELDS: readonly RuleConditionField[] = ['from', 'to', 'subject', 'body', 'size', 'hasAttachment'];
const OPS: readonly RuleConditionOp[] = ['contains', 'not_contains', 'is', 'starts_with', 'ends_with'];

type MailboxLike = Pick<Mailbox, 'id' | 'name' | 'parentId' | 'role'>;

function isObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Mailboxes that are the app's own, never a place for a rule to file mail. */
function isAppMailbox(m: MailboxLike): boolean {
	return isScheduledMailbox(m) || (m.parentId === null && m.name === REMIND_ME_LATER_NAME);
}

function parseConditions(input: unknown, problems: RuleProblem[]): RuleCondition[] {
	if (!Array.isArray(input) || input.length === 0) {
		problems.push({ field: 'conditions', message: 'Add a condition: what mail should this rule act on?' });
		return [];
	}
	if (input.length > MAX_CONDITIONS) {
		problems.push({ field: 'conditions', message: `A rule can have at most ${MAX_CONDITIONS} conditions.` });
	}
	const out: RuleCondition[] = [];
	input.slice(0, MAX_CONDITIONS).forEach((c, index) => {
		const bad = (message: string) => problems.push({ field: 'conditions', index, message });
		if (!isObject(c) || !FIELDS.includes(c.field as RuleConditionField)) {
			return bad('Pick what this condition looks at.');
		}
		const field = c.field as RuleConditionField;
		const op = (c.op ?? 'contains') as RuleConditionOp;
		if (!OPS.includes(op)) return bad('Pick how this condition matches.');
		const value = field === 'hasAttachment' ? '' : typeof c.value === 'string' ? c.value : typeof c.value === 'number' ? String(c.value) : '';
		if (value.length > MAX_VALUE) return bad(`Keep this to ${MAX_VALUE} characters or fewer.`);
		if (field === 'size' && value.trim() !== '' && !/^\d+$/.test(value.trim())) {
			return bad('Give the size as a whole number of KB.');
		}
		const id = typeof c.id === 'string' && c.id !== '' && c.id.length <= 64 ? c.id : `c_${randomUUID()}`;
		const condition: RuleCondition = { id, field, op, value: field === 'size' ? value.trim() : value, negate: c.negate === true };
		// A condition left empty is dropped, so a half-finished rule never
		// becomes match-everything (see isUsableCondition).
		if (isUsableCondition(condition)) out.push(condition);
	});
	if (out.length === 0 && !problems.some((p) => p.field === 'conditions')) {
		problems.push({ field: 'conditions', message: 'Give at least one condition something to match.' });
	}
	return out;
}

function parseTarget(input: unknown, mailboxes: MailboxLike[], problems: RuleProblem[]): RuleTarget {
	const bad = (message: string): RuleTarget => {
		problems.push({ field: 'target', message });
		return { kind: 'none' };
	};
	if (input === undefined || input === null) return { kind: 'none' };
	if (!isObject(input)) return bad('Pick where this rule files mail.');
	const kind = input.kind;
	if (kind === 'none') return { kind: 'none' };
	if (RULE_ROLES.includes(kind as RuleRole)) {
		const role = kind as RuleRole;
		if (!mailboxes.some((m) => m.role === role)) return bad(`This account has no ${role === 'junk' ? 'Junk' : role === 'trash' ? 'Trash' : 'Archive'} folder.`);
		return { kind: role };
	}
	if (kind !== 'folder' && kind !== 'label') return bad('Pick where this rule files mail.');
	const id = typeof input.mailboxId === 'string' ? input.mailboxId : '';
	const box = mailboxes.find((m) => m.id === id);
	if (!box) return bad(`Pick a ${kind}: the one chosen no longer exists.`);
	const labelsParentId = findLabelsParentId(mailboxes);
	if (kind === 'label') {
		if (!labelMailboxIds(mailboxes).has(id)) return bad(`“${box.name}” is a folder, not a label.`);
		return { kind: 'label', mailboxId: id };
	}
	if (isLabelsParent(box, labelsParentId)) return bad('“Labels” holds your labels: pick a folder or a label.');
	if (isLabelMailbox(box, labelsParentId)) return bad(`“${box.name}” is a label, not a folder.`);
	if (isAppMailbox(box)) return bad(`Rules can’t file mail into “${box.name}”.`);
	// Trash, Archive and Junk are named by their role; no other folder with a
	// role (the Inbox, Sent, Drafts) is somewhere a rule files mail.
	if (RULE_ROLES.includes(box.role as RuleRole)) return { kind: box.role as RuleRole };
	if (box.role) return bad(`Rules can’t file mail into “${box.name}”.`);
	return { kind: 'folder', mailboxId: id };
}

/**
 * Check and clean a rule a browser sent. `mailboxes` are the account's
 * (from Mailbox/get): a target must be one of them, of the kind it says.
 */
export function parseRule(input: unknown, mailboxes: MailboxLike[]): ParsedRule {
	const problems: RuleProblem[] = [];
	const body = isObject(input) ? input : {};

	const name = typeof body.name === 'string' ? body.name.trim() : '';
	if (name === '') problems.push({ field: 'name', message: 'Give the rule a name.' });
	else if (name.length > MAX_NAME) problems.push({ field: 'name', message: `Keep the name to ${MAX_NAME} characters or fewer.` });

	const logic = body.logic ?? 'allof';
	if (logic !== 'allof' && logic !== 'anyof') problems.push({ field: 'logic', message: 'Match all or any of the conditions.' });

	const conditions = parseConditions(body.conditions, problems);
	const target = parseTarget(body.target, mailboxes, problems);
	const markRead = body.markRead === true;
	const star = body.star === true;
	const stop = body.stop === true;
	if (target.kind === 'none' && !markRead && !star && !problems.some((p) => p.field === 'target')) {
		problems.push({ field: 'actions', message: 'Give the rule something to do: a place to file mail, mark as read, or star.' });
	}

	return {
		rule: {
			name: name.slice(0, MAX_NAME),
			enabled: body.enabled !== false,
			logic: logic === 'anyof' ? 'anyof' : 'allof',
			conditions,
			target,
			markRead,
			star,
			stop
		},
		problems
	};
}
