import {
	isRunnable,
	isUsableCondition,
	type Rule,
	type RuleCondition,
	type RuleAction,
	type RuleConditionOp
} from '$lib/types/rules';
import { CATEGORY_KEYWORDS, categoryKeywordPatch, isInboxCategory } from '$lib/types/categories';
import type { Mailbox } from '$lib/jmap/types';
import { findLabelsParentId, isLabelMailbox } from '$lib/types/labels';

export interface AutoReplyConfig {
	enabled: boolean;
	subject: string;
	body: string;
}

export interface SieveContext {
	mailboxById: Map<string, Mailbox>;
	mailboxByName: Map<string, Mailbox>;
	/** id of the "Labels" container, so applyLabel can verify its target. */
	labelsParentId: string | null;
	/** Where "Move to trash" files mail; null leaves the action out. */
	trash: Mailbox | null;
}

export function buildSieveContext(mailboxes: Mailbox[]): SieveContext {
	return {
		mailboxById: new Map(mailboxes.map((m) => [m.id, m])),
		mailboxByName: new Map(mailboxes.map((m) => [m.name, m])),
		labelsParentId: findLabelsParentId(mailboxes),
		trash: mailboxes.find((m) => m.role === 'trash') ?? null
	};
}

/**
 * Build the full IMAP mailbox path for `fileinto`, walking the parentId chain
 * and joining with the `/` hierarchy separator. A top-level "Code" stays
 * "Code"; a label child "Work Stuff" under "Labels" becomes "Labels/Work
 * Stuff" — which is exactly how the mailbox is named over IMAP.
 */
function mailboxImapPath(mb: Mailbox, ctx: SieveContext): string {
	const parts: string[] = [];
	let cur: Mailbox | undefined = mb;
	const seen = new Set<string>();
	while (cur && !seen.has(cur.id)) {
		seen.add(cur.id);
		parts.unshift(cur.name);
		cur = cur.parentId ? ctx.mailboxById.get(cur.parentId) : undefined;
	}
	return parts.join('/');
}

export function compileRulesToSieve(
	rules: Rule[],
	ctx: SieveContext,
	autoReply?: AutoReplyConfig
): string {
	// Only rules that may run: one waiting for its owner to rewrite it is
	// left out, as it is by the app's own engine.
	const activeRules = rules.filter(isRunnable);
	const autoReplyActive = !!autoReply?.enabled && autoReply.body.trim().length > 0;

	// Nothing to emit — keep the minimum require line so the server still
	// parses the script cleanly.
	if (activeRules.length === 0 && !autoReplyActive) {
		return `require ["fileinto", "imap4flags", "envelope", "header"];\n\n# No active rules\n`;
	}

	// `copy` is required for `fileinto :copy` used by applyLabel.
	// `vacation` is required when we emit the auto-reply block.
	const requires = ['fileinto', 'imap4flags', 'envelope', 'header', 'body', 'copy'];
	if (autoReplyActive) requires.push('vacation');

	const lines: string[] = [
		`require [${requires.map((r) => `"${r}"`).join(', ')}];`,
		''
	];

	if (autoReplyActive && autoReply) {
		// Bare `vacation` with :days 1 rate-limits replies to the same sender
		// to once per day — the canonical vacation-auto-reply behavior.
		const subject = autoReply.subject.trim() || 'Out of office';
		lines.push('# Auto-reply (vacation)');
		lines.push(`vacation :days 1 :subject "${escSieve(subject)}" "${escSieve(autoReply.body)}";`);
		lines.push('');
	}

	for (const rule of activeRules) {
		// Drop empty/unusable conditions; skip the rule entirely if none
		// remain so we never emit a filter that matches every message. (An
		// empty text value would compile to `:contains "Header" ""`, which
		// matches every message.)
		const usableConditions = rule.conditions.filter(isUsableCondition);
		if (usableConditions.length === 0) continue;

		lines.push(`# Rule: ${rule.name}`);

		const conditions = usableConditions.map(compileCondition);
		let condBlock: string;
		if (usableConditions.length === 1) {
			condBlock = conditions[0];
		} else {
			condBlock = `${rule.logic} (\n  ${conditions.join(',\n  ')}\n)`;
		}

		lines.push(`if ${condBlock} {`);
		for (const action of rule.actions) {
			const compiled = compileAction(action, ctx);
			if (compiled) lines.push(`  ${compiled}`);
		}
		lines.push(`}`);
		lines.push('');
	}

	return lines.join('\n');
}

function compileCondition(c: RuleCondition): string {
	let test = '';

	switch (c.field) {
		case 'from':
			test = opToSieve('header', 'From', c.op, c.value);
			break;
		case 'to':
			test = opToSieve('header', 'To', c.op, c.value);
			break;
		case 'subject':
			test = opToSieve('header', 'Subject', c.op, c.value);
			break;
		case 'body':
			test = `body :text :contains "${escSieve(c.value)}"`;
			break;
		case 'size':
			test = `size :over ${parseInt(c.value) * 1024}`;
			break;
		case 'hasAttachment':
			test = `header :contains "Content-Type" "multipart"`;
			break;
	}

	return c.negate ? `not ${test}` : test;
}

function opToSieve(type: string, header: string, op: RuleConditionOp, value: string): string {
	const v = escSieve(value);
	switch (op) {
		case 'contains':     return `${type} :contains "${header}" "${v}"`;
		case 'not_contains': return `not ${type} :contains "${header}" "${v}"`;
		case 'is':           return `${type} :is "${header}" "${v}"`;
		case 'starts_with':  return `${type} :matches "${header}" "${v}*"`;
		case 'ends_with':    return `${type} :matches "${header}" "*${v}"`;
		default:             return `${type} :contains "${header}" "${v}"`;
	}
}

/**
 * Resolve `action.value` to a mailbox — rules created from the new editor
 * use ids; older rules referenced mailboxes by name. Prefer id, fall back
 * to name.
 */
function resolveMailbox(value: string | undefined, ctx: SieveContext): Mailbox | null {
	if (!value) return null;
	return ctx.mailboxById.get(value) ?? ctx.mailboxByName.get(value) ?? null;
}

function compileAction(a: RuleAction, ctx: SieveContext): string {
	switch (a.type) {
		case 'moveToFolder': {
			const mb = resolveMailbox(a.value, ctx);
			if (!mb) return '';
			// `fileinto` moves by default — no `:copy`. Use the full IMAP path
			// so nested folders resolve correctly.
			return `fileinto "${escSieve(mailboxImapPath(mb, ctx))}";`;
		}
		case 'applyLabel': {
			const mb = resolveMailbox(a.value, ctx);
			// Target must be an actual label (a child of the Labels container).
			if (!mb || !isLabelMailbox(mb, ctx.labelsParentId)) return '';
			// `:copy` keeps the message in its original mailbox AND files it
			// into the label folder — the multi-mailbox membership labels use.
			// The path is `Labels/<name>` so it lands in the right place.
			return `fileinto :copy "${escSieve(mailboxImapPath(mb, ctx))}";`;
		}
		case 'markRead':       return `addflag "\\\\Seen";`;
		case 'markImportant':  return `addflag "\\\\Flagged";`;
		case 'setCategory': {
			// Inbox tabs are keywords: clear the other tabs, set this one.
			if (!isInboxCategory(a.value)) return '';
			const on = Object.entries(categoryKeywordPatch(a.value)).filter(([, v]) => v).map(([k]) => k);
			const all = Object.values(CATEGORY_KEYWORDS).map((k) => `"${k}"`).join(', ');
			return `removeflag [${all}];${on.length ? ` addflag "${on[0]}";` : ''}`;
		}
		case 'delete':
			// Never `discard`: that destroys the message at delivery. Filing it
			// into Trash matches the app's own engine, which doesn't stop either.
			return ctx.trash ? `fileinto "${escSieve(mailboxImapPath(ctx.trash, ctx))}";` : '';
		case 'stopProcessing': return `stop;`;
		default:               return '';
	}
}

function escSieve(s: string): string {
	return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
