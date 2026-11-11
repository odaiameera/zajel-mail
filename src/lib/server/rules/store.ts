import { randomUUID } from 'node:crypto';
import { getDb } from '../db/index';
import {
	needsRewrite,
	RULE_ROLES,
	type LegacyRule,
	type Rule,
	type RuleAttention,
	type RuleDraft,
	type RuleNote,
	type RuleRole,
	type RuleTarget
} from '$lib/types/rules';

/**
 * The rules table (migration 030): an account's rules, one row each, in
 * the order they run. Everything here is by account row id, and a rule id
 * from another account is simply not found.
 *
 * What reaches `createRule` and `updateRule` has been through `parseRule`
 * (rules/schema.ts). `attention`, `note` and `legacy` are never taken from
 * a draft: only an upgrade sets them, and only the owner's dealing with
 * the rule (saving it as an exact rule, or dismissing its note) clears them.
 */

interface RuleRow {
	account_id: string;
	id: string;
	position: number;
	enabled: number;
	name: string;
	logic: string;
	conditions_json: string;
	target_kind: string;
	target_mailbox_id: string | null;
	target_role: string | null;
	mark_read: number;
	star: number;
	stop: number;
	attention: string | null;
	note_json: string | null;
	legacy_json: string | null;
	created_at: number;
	updated_at: number;
}

let _stmts: ReturnType<typeof prepareStmts> | null = null;

// Prepared lazily, as in the other query modules: preparing at module scope
// would open the database during `vite build`'s SSR pass.
function prepareStmts() {
	const db = getDb();
	return {
		list: db.prepare('SELECT * FROM rules WHERE account_id = ? ORDER BY position, created_at'),
		get: db.prepare('SELECT * FROM rules WHERE account_id = ? AND id = ?'),
		count: db.prepare('SELECT COUNT(*) AS n FROM rules WHERE account_id = ?'),
		nextPosition: db.prepare('SELECT COALESCE(MAX(position) + 1, 0) AS p FROM rules WHERE account_id = ?'),
		insert: db.prepare(
			`INSERT INTO rules (account_id, id, position, enabled, name, logic, conditions_json, target_kind,
			   target_mailbox_id, target_role, mark_read, star, stop, attention, note_json, legacy_json, created_at, updated_at)
			 VALUES (@account_id, @id, @position, @enabled, @name, @logic, @conditions_json, @target_kind,
			   @target_mailbox_id, @target_role, @mark_read, @star, @stop, @attention, @note_json, @legacy_json, @created_at, @updated_at)`
		),
		update: db.prepare(
			`UPDATE rules SET enabled = @enabled, name = @name, logic = @logic, conditions_json = @conditions_json,
			   target_kind = @target_kind, target_mailbox_id = @target_mailbox_id, target_role = @target_role,
			   mark_read = @mark_read, star = @star, stop = @stop, attention = @attention, note_json = @note_json,
			   legacy_json = @legacy_json, updated_at = @updated_at
			 WHERE account_id = @account_id AND id = @id`
		),
		setBasics: db.prepare(
			'UPDATE rules SET name = @name, enabled = @enabled, updated_at = @updated_at WHERE account_id = @account_id AND id = @id'
		),
		remove: db.prepare('DELETE FROM rules WHERE account_id = ? AND id = ?'),
		setPosition: db.prepare('UPDATE rules SET position = ? WHERE account_id = ? AND id = ?'),
		// A rule that does nothing but file into the mailbox goes; one that
		// also marks read, stars or stops later rules keeps doing that.
		forMailboxDelete: db.prepare(
			`DELETE FROM rules WHERE account_id = ? AND target_kind IN ('folder', 'label') AND target_mailbox_id = ?
			   AND mark_read = 0 AND star = 0 AND stop = 0`
		),
		forMailboxKeep: db.prepare(
			`UPDATE rules SET target_kind = 'none', target_mailbox_id = NULL, target_role = NULL, updated_at = ?
			 WHERE account_id = ? AND target_kind IN ('folder', 'label') AND target_mailbox_id = ?`
		)
	};
}
function stmts() {
	return (_stmts ??= prepareStmts());
}

function parseJson<T>(text: string | null): T | undefined {
	if (!text) return undefined;
	try {
		return JSON.parse(text) as T;
	} catch {
		return undefined;
	}
}

function targetOf(row: RuleRow): RuleTarget {
	if ((row.target_kind === 'folder' || row.target_kind === 'label') && row.target_mailbox_id) {
		return { kind: row.target_kind, mailboxId: row.target_mailbox_id };
	}
	if (row.target_kind === 'role' && RULE_ROLES.includes(row.target_role as RuleRole)) {
		return { kind: row.target_role as RuleRole };
	}
	return { kind: 'none' };
}

function fromRow(row: RuleRow): Rule {
	const conditions = parseJson<Rule['conditions']>(row.conditions_json);
	const note = parseJson<RuleNote>(row.note_json);
	const legacy = parseJson<LegacyRule>(row.legacy_json);
	return {
		id: row.id,
		position: row.position,
		name: row.name,
		enabled: row.enabled === 1,
		logic: row.logic === 'anyof' ? 'anyof' : 'allof',
		conditions: Array.isArray(conditions) ? conditions : [],
		target: targetOf(row),
		markRead: row.mark_read === 1,
		star: row.star === 1,
		stop: row.stop === 1,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		...(row.attention ? { attention: row.attention as RuleAttention } : {}),
		...(note ? { note } : {}),
		...(legacy ? { legacy } : {})
	};
}

function toRow(accountId: string, rule: Rule): RuleRow {
	const t = rule.target;
	return {
		account_id: accountId,
		id: rule.id,
		position: rule.position,
		enabled: rule.enabled ? 1 : 0,
		name: rule.name,
		logic: rule.logic,
		conditions_json: JSON.stringify(rule.conditions ?? []),
		target_kind: t.kind === 'folder' || t.kind === 'label' || t.kind === 'none' ? t.kind : 'role',
		target_mailbox_id: t.kind === 'folder' || t.kind === 'label' ? t.mailboxId : null,
		target_role: t.kind === 'folder' || t.kind === 'label' || t.kind === 'none' ? null : t.kind,
		mark_read: rule.markRead ? 1 : 0,
		star: rule.star ? 1 : 0,
		stop: rule.stop ? 1 : 0,
		attention: rule.attention ?? null,
		note_json: rule.note ? JSON.stringify(rule.note) : null,
		legacy_json: rule.legacy ? JSON.stringify(rule.legacy) : null,
		created_at: rule.createdAt,
		updated_at: rule.updatedAt
	};
}

/** Only what an owner may say: a draft can carry nothing else into a row. */
function draftFields(draft: RuleDraft): RuleDraft {
	const { name, enabled, logic, conditions, target, markRead, star, stop } = draft;
	return { name, enabled, logic, conditions, target, markRead, star, stop };
}

/** An account's rules, in the order they run. */
export function listRules(accountId: string): Rule[] {
	return (stmts().list.all(accountId) as RuleRow[]).map(fromRow);
}

export function getRule(accountId: string, id: string): Rule | null {
	const row = stmts().get.get(accountId, id) as RuleRow | undefined;
	return row ? fromRow(row) : null;
}

/** How many rules an account has. */
export function countRules(accountId: string): number {
	return (stmts().count.get(accountId) as { n: number }).n;
}

/** A new rule, at the end of the list. */
export function createRule(accountId: string, draft: RuleDraft, now = Date.now()): Rule {
	const s = stmts();
	const position = (s.nextPosition.get(accountId) as { p: number }).p;
	const rule: Rule = { ...draftFields(draft), id: `rule_${randomUUID()}`, position, createdAt: now, updatedAt: now };
	s.insert.run(toRow(accountId, rule));
	return rule;
}

/**
 * Save an owner's whole edit, one that passed `parseRule`. A rule switched
 * off for good by an upgrade (see `needsRewrite`) comes back on only with
 * `rewrite`: that is "Save as exact rule", and its flag, note and old copy
 * go. Any other edit of it is saved, but leaves it flagged and off. Any
 * other note stays until it is dismissed.
 */
export function updateRule(
	accountId: string,
	id: string,
	draft: RuleDraft,
	{ rewrite = false, now = Date.now() }: { rewrite?: boolean; now?: number } = {}
): Rule | null {
	const existing = getRule(accountId, id);
	if (!existing) return null;
	const flagged = needsRewrite(existing);
	const { attention, note, legacy, ...kept } = existing;
	const rule: Rule = { ...kept, ...draftFields(draft), updatedAt: now };
	if (flagged && rewrite) rule.enabled = true;
	else {
		Object.assign(rule, { attention, note, legacy });
		if (flagged) rule.enabled = false;
	}
	stmts().update.run(toRow(accountId, rule));
	return getRule(accountId, id);
}

/**
 * Rename a rule or switch it on or off, touching nothing else: its
 * conditions and target stay exactly as stored, whatever a new rule would
 * be held to now. A rule waiting to be rewritten stays off.
 */
export function setRuleBasics(
	accountId: string,
	id: string,
	change: { name?: string; enabled?: boolean },
	now = Date.now()
): Rule | null {
	const existing = getRule(accountId, id);
	if (!existing) return null;
	const enabled = needsRewrite(existing) ? false : (change.enabled ?? existing.enabled);
	stmts().setBasics.run({
		account_id: accountId,
		id,
		name: change.name ?? existing.name,
		enabled: enabled ? 1 : 0,
		updated_at: now
	});
	return getRule(accountId, id);
}

export function deleteRule(accountId: string, id: string): boolean {
	return stmts().remove.run(accountId, id).changes > 0;
}

/**
 * Put an account's rules in this order. `ids` must be exactly the
 * account's rule ids, each once: a list made from a stale page would
 * otherwise drop a rule out of the order or reorder someone else's.
 */
export function reorderRules(accountId: string, ids: string[]): boolean {
	const current = listRules(accountId).map((r) => r.id);
	if (ids.length !== current.length || new Set(ids).size !== ids.length) return false;
	if (!ids.every((id) => current.includes(id))) return false;
	const s = stmts();
	getDb().transaction(() => {
		ids.forEach((id, i) => s.setPosition.run(i, accountId, id));
	})();
	return true;
}

/**
 * The owner has read a rule's note.
 *
 * - `tab_pinned`: what is left of a rule that became a pin is only its
 *   note, so the rule goes.
 * - `tab_removed` and `split`: the rule runs as it is; the note goes.
 * - A rule waiting to be rewritten keeps its flag (it is dealt with by
 *   rewriting or deleting it), and loses only a split note it carries.
 *
 * Null when there is no such rule; 'nothing' when it has no note to dismiss.
 */
export function dismissNote(accountId: string, id: string, now = Date.now()): 'deleted' | 'cleared' | 'nothing' | null {
	const rule = getRule(accountId, id);
	if (!rule) return null;
	if (rule.attention === 'tab_pinned') {
		deleteRule(accountId, id);
		return 'deleted';
	}
	if (rule.attention === 'tab_removed' || rule.attention === 'split') {
		const { attention: _a, note: _n, legacy: _l, ...rest } = rule;
		stmts().update.run(toRow(accountId, { ...rest, updatedAt: now }));
		return 'cleared';
	}
	if (rule.note?.splitInto) {
		const { splitInto: _s, ...note } = rule.note;
		const next: Rule = { ...rule, updatedAt: now };
		if (Object.keys(note).length > 0) next.note = note;
		else delete next.note;
		stmts().update.run(toRow(accountId, next));
		return 'cleared';
	}
	return 'nothing';
}

/**
 * A folder or label is being deleted. The rules that only file into it go
 * with it. One that also marks read, stars or stops later rules is kept,
 * filing nowhere, so it goes on doing that: deleting it would quietly let
 * the rules below it act on mail it used to stop. How many of each.
 */
export function deleteRulesForMailbox(
	accountId: string,
	mailboxId: string,
	now = Date.now()
): { deleted: number; kept: number } {
	const s = stmts();
	return getDb().transaction(() => {
		const deleted = s.forMailboxDelete.run(accountId, mailboxId).changes;
		const kept = s.forMailboxKeep.run(now, accountId, mailboxId).changes;
		return { deleted, kept };
	})();
}

/**
 * Write rules an upgrade has converted, as they are, flags and all, after
 * any the account has. Only the upgrade calls this: everything an owner
 * sends goes through createRule and updateRule.
 */
export function importRules(accountId: string, rules: Rule[]): void {
	const s = stmts();
	const start = (s.nextPosition.get(accountId) as { p: number }).p;
	rules.forEach((rule, i) => s.insert.run(toRow(accountId, { ...rule, position: start + i })));
}
