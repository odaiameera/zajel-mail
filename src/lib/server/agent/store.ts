import { randomUUID } from 'node:crypto';
import { getDb } from '../db/index';

/**
 * Pending actions (outward changes waiting for your click) and the audit log
 * of everything the agent did. See migration 021.
 */

export type AgentSource = 'chat' | 'telegram' | 'job';
export type ToolTier = 'read' | 'self' | 'outward';
export type ActionStatus = 'pending' | 'done' | 'cancelled' | 'failed' | 'expired';

/** How long a proposal can wait for a decision. */
const ACTION_TTL_MS = 24 * 60 * 60 * 1000;
/** The kind of the agent_actions row that journals a running chat turn. */
const JOURNAL_KIND = 'turn_journal';
/** How long the audit log keeps an entry. */
const AUDIT_DAYS = 90;

export interface PendingAction {
	id: string;
	userId: string;
	accountId: string;
	conversationId: string | null;
	kind: string;
	payload: Record<string, unknown>;
	status: ActionStatus;
	result: string | null;
	createdAt: string;
	expiresAt: string;
}

interface ActionRow {
	id: string;
	user_id: string;
	account_id: string;
	conversation_id: string | null;
	kind: string;
	payload_json: string;
	status: ActionStatus;
	result: string | null;
	created_at: string;
	expires_at: string;
}

let _stmts: ReturnType<typeof prepareStmts> | null = null;
function prepareStmts() {
	const db = getDb();
	return {
		insert: db.prepare(
			`INSERT INTO agent_actions (id, user_id, account_id, conversation_id, kind, payload_json, expires_at)
			 VALUES (@id, @userId, @accountId, @conversationId, @kind, @payload, @expiresAt)`
		),
		get: db.prepare(`SELECT * FROM agent_actions WHERE id = ? AND user_id = ?`),
		pendingIn: db.prepare(
			`SELECT * FROM agent_actions
			 WHERE user_id = ? AND conversation_id = ? AND status = 'pending' AND expires_at > datetime('now')
			 ORDER BY created_at, rowid`
		),
		// Only a pending, unexpired action can be claimed, and only once.
		claim: db.prepare(
			`UPDATE agent_actions SET status = @status, decided_at = datetime('now')
			 WHERE id = @id AND user_id = @userId AND status = 'pending' AND expires_at > datetime('now')`
		),
		finish: db.prepare(`UPDATE agent_actions SET status = ?, result = ? WHERE id = ?`),
		expire: db.prepare(
			`UPDATE agent_actions SET status = 'expired' WHERE status = 'pending' AND expires_at <= datetime('now')`
		),
		audit: db.prepare(
			`INSERT INTO agent_audit (user_id, account_id, source, tool, tier, summary, outcome)
			 VALUES (@userId, @accountId, @source, @tool, @tier, @summary, @outcome)`
		),
		auditList: db.prepare(
			`SELECT tool, tier, summary, outcome, source, created_at FROM agent_audit
			 WHERE user_id = ? ORDER BY id DESC LIMIT ?`
		),
		auditPrune: db.prepare(`DELETE FROM agent_audit WHERE created_at < datetime('now', ?)`),
		// A running chat turn's journal: an agent_actions row that is never a
		// card (its own kind, status 'done'), see the journal section below.
		journalInsert: db.prepare(
			`INSERT INTO agent_actions (id, user_id, account_id, conversation_id, kind, payload_json, status, expires_at)
			 VALUES (@id, @userId, @accountId, @conversationId, '${JOURNAL_KIND}', @payload, 'done', @expiresAt)`
		),
		journalGet: db.prepare(`SELECT payload_json FROM agent_actions WHERE id = ? AND kind = '${JOURNAL_KIND}'`),
		journalNote: db.prepare(`UPDATE agent_actions SET payload_json = ? WHERE id = ? AND kind = '${JOURNAL_KIND}'`),
		journalEnd: db.prepare(`DELETE FROM agent_actions WHERE id = ? AND kind = '${JOURNAL_KIND}'`),
		journalLeft: db.prepare(
			`SELECT id, payload_json FROM agent_actions
			 WHERE user_id = ? AND conversation_id = ? AND kind = '${JOURNAL_KIND}' AND expires_at > datetime('now')
			 ORDER BY created_at, rowid`
		),
		journalPrune: db.prepare(`DELETE FROM agent_actions WHERE kind = '${JOURNAL_KIND}' AND expires_at <= datetime('now')`)
	};
}
function stmts() {
	return (_stmts ??= prepareStmts());
}

function toAction(row: ActionRow): PendingAction {
	return {
		id: row.id,
		userId: row.user_id,
		accountId: row.account_id,
		conversationId: row.conversation_id,
		kind: row.kind,
		payload: JSON.parse(row.payload_json),
		status: row.status,
		result: row.result,
		createdAt: row.created_at,
		expiresAt: row.expires_at
	};
}

export function createPendingAction(input: {
	userId: string;
	accountId: string;
	conversationId: string | null;
	kind: string;
	payload: Record<string, unknown>;
}): PendingAction {
	const id = randomUUID();
	const expiresAt = new Date(Date.now() + ACTION_TTL_MS).toISOString().replace('T', ' ').slice(0, 19);
	stmts().insert.run({ ...input, id, payload: JSON.stringify(input.payload), expiresAt });
	return getPendingAction(input.userId, id)!;
}

export function getPendingAction(userId: string, id: string): PendingAction | null {
	stmts().expire.run();
	const row = stmts().get.get(id, userId) as ActionRow | undefined;
	return row ? toAction(row) : null;
}

/**
 * What still waits for a click in one chat session, oldest first. The panel
 * asks for these with the session, so a card survives a reply that never
 * reached the browser, and a reload.
 */
export function listPendingActions(userId: string, conversationId: string): PendingAction[] {
	return (stmts().pendingIn.all(userId, conversationId) as ActionRow[]).map(toAction);
}

/**
 * Take a pending action for a decision. Returns false when it is not yours,
 * already decided, or expired, so a double click or a replay can't run it
 * twice.
 */
export function claimPendingAction(userId: string, id: string, decision: 'done' | 'cancelled'): boolean {
	return stmts().claim.run({ id, userId, status: decision }).changes === 1;
}

export function finishPendingAction(id: string, status: 'done' | 'failed', result: string): void {
	stmts().finish.run(status, result.slice(0, 500), id);
}

export function recordAudit(entry: {
	userId: string;
	accountId: string | null;
	source: AgentSource;
	tool: string;
	tier: ToolTier;
	summary: string;
	outcome: 'done' | 'proposed' | 'refused' | 'failed';
}): void {
	stmts().audit.run({ ...entry, summary: entry.summary.slice(0, 500) });
}

export interface AuditEntry {
	tool: string;
	tier: ToolTier;
	summary: string;
	outcome: string;
	source: AgentSource;
	createdAt: string;
}

/**
 * A chat turn's journal: what it has changed so far, kept while it runs and
 * removed once its reply is saved. A journal still there when the next turn
 * in that session starts means the process stopped mid-turn, so that turn
 * puts what was done into the transcript before it runs (see the agent
 * route), and nothing is done twice or forgotten.
 */

export interface InterruptedTurn {
	/** What the user asked. */
	message: string;
	/** The changes made before the turn was cut short, in order. */
	done: string[];
}

export function startTurnJournal(input: { userId: string; accountId: string; conversationId: string; message: string }): string {
	const id = randomUUID();
	const expiresAt = new Date(Date.now() + ACTION_TTL_MS).toISOString().replace('T', ' ').slice(0, 19);
	stmts().journalInsert.run({ ...input, id, payload: JSON.stringify({ message: input.message, done: [] }), expiresAt });
	return id;
}

export function noteTurnProgress(id: string, done: string[]): void {
	const row = stmts().journalGet.get(id) as { payload_json: string } | undefined;
	if (!row) return;
	const message = (JSON.parse(row.payload_json) as InterruptedTurn).message;
	stmts().journalNote.run(JSON.stringify({ message, done }), id);
}

export function endTurnJournal(id: string): void {
	stmts().journalEnd.run(id);
}

/** The journals of turns cut short in one session, oldest first, each handed over once; empty ones are just dropped. */
export function takeInterruptedTurns(userId: string, conversationId: string): InterruptedTurn[] {
	stmts().journalPrune.run();
	const rows = stmts().journalLeft.all(userId, conversationId) as { id: string; payload_json: string }[];
	const turns: InterruptedTurn[] = [];
	for (const row of rows) {
		stmts().journalEnd.run(row.id);
		const turn = JSON.parse(row.payload_json) as InterruptedTurn;
		if (turn.done.length) turns.push({ message: turn.message, done: turn.done });
	}
	return turns;
}

export function listAudit(userId: string, limit = 100): AuditEntry[] {
	stmts().auditPrune.run(`-${AUDIT_DAYS} days`);
	return (stmts().auditList.all(userId, limit) as {
		tool: string;
		tier: ToolTier;
		summary: string;
		outcome: string;
		source: AgentSource;
		created_at: string;
	}[]).map((row) => ({ ...row, createdAt: row.created_at }));
}
