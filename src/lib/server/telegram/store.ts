import { randomBytes, randomUUID } from 'node:crypto';
import { getDb } from '../db/index';

/** Telegram links, link codes, button tokens and agent reminders. See migration 022. */

const CODE_TTL_MS = 10 * 60 * 1000;
const BUTTON_TTL_DAYS = 7;

export interface TelegramLink {
	userId: string;
	chatId: string;
	username: string | null;
	urgent: boolean;
	paused: boolean;
}

export interface ButtonToken {
	userId: string;
	accountId: string;
	emailId: string;
	action: 'read' | 'snooze' | 'archive';
}

export interface AgentReminder {
	id: string;
	userId: string;
	accountId: string | null;
	emailId: string | null;
	text: string;
	dueAt: string;
}

let _stmts: ReturnType<typeof prepareStmts> | null = null;
function prepareStmts() {
	const db = getDb();
	return {
		linkGet: db.prepare(`SELECT * FROM telegram_links WHERE user_id = ?`),
		linkByChat: db.prepare(`SELECT * FROM telegram_links WHERE chat_id = ?`),
		linkUpsert: db.prepare(
			`INSERT INTO telegram_links (user_id, chat_id, username) VALUES (?, ?, ?)
			 ON CONFLICT (user_id) DO UPDATE SET chat_id = excluded.chat_id, username = excluded.username,
			   paused = 0, linked_at = datetime('now')`
		),
		linkDeleteChat: db.prepare(`DELETE FROM telegram_links WHERE chat_id = ? AND user_id != ?`),
		linkDelete: db.prepare(`DELETE FROM telegram_links WHERE user_id = ?`),
		linkSet: db.prepare(`UPDATE telegram_links SET urgent = COALESCE(?, urgent), paused = COALESCE(?, paused) WHERE user_id = ?`),
		codeInsert: db.prepare(`INSERT INTO telegram_link_codes (code, user_id, expires_at) VALUES (?, ?, ?)`),
		codeTake: db.prepare(`DELETE FROM telegram_link_codes WHERE code = ? RETURNING user_id, expires_at`),
		codePrune: db.prepare(`DELETE FROM telegram_link_codes WHERE expires_at < ?`),
		buttonInsert: db.prepare(
			`INSERT INTO telegram_buttons (id, user_id, account_id, email_id, action) VALUES (?, ?, ?, ?, ?)`
		),
		buttonTake: db.prepare(
			`UPDATE telegram_buttons SET used_at = datetime('now')
			 WHERE id = ? AND used_at IS NULL AND created_at > datetime('now', ?)
			 RETURNING user_id, account_id, email_id, action`
		),
		buttonPrune: db.prepare(`DELETE FROM telegram_buttons WHERE created_at < datetime('now', ?)`),
		reminderInsert: db.prepare(
			`INSERT INTO agent_reminders (id, user_id, account_id, email_id, text, due_at) VALUES (?, ?, ?, ?, ?, ?)`
		),
		remindersDue: db.prepare(
			`SELECT id, user_id, account_id, email_id, text, due_at FROM agent_reminders
			 WHERE sent_at IS NULL AND due_at <= ? ORDER BY due_at LIMIT 50`
		),
		reminderSent: db.prepare(`UPDATE agent_reminders SET sent_at = datetime('now') WHERE id = ? AND sent_at IS NULL`),
		stateGet: db.prepare(`SELECT value FROM telegram_state WHERE key = ?`),
		stateSet: db.prepare(
			`INSERT INTO telegram_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`
		)
	};
}
function stmts() {
	return (_stmts ??= prepareStmts());
}

type LinkRow = { user_id: string; chat_id: string; username: string | null; urgent: number; paused: number };
const toLink = (row: LinkRow): TelegramLink => ({
	userId: row.user_id,
	chatId: row.chat_id,
	username: row.username,
	urgent: row.urgent === 1,
	paused: row.paused === 1
});

export function getLink(userId: string): TelegramLink | null {
	const row = stmts().linkGet.get(userId) as LinkRow | undefined;
	return row ? toLink(row) : null;
}

export function getLinkByChat(chatId: string): TelegramLink | null {
	const row = stmts().linkByChat.get(chatId) as LinkRow | undefined;
	return row ? toLink(row) : null;
}

/** A fresh single-use code for the t.me link; the caller has re-checked already. */
export function createLinkCode(userId: string, nowMs = Date.now()): string {
	stmts().codePrune.run(new Date(nowMs).toISOString());
	const code = randomBytes(18).toString('base64url');
	stmts().codeInsert.run(code, userId, new Date(nowMs + CODE_TTL_MS).toISOString());
	return code;
}

/**
 * Bind the chat that sent a valid /start code. The code is spent whatever
 * happens; a chat can belong to only one login.
 */
export function linkChatWithCode(code: string, chatId: string, username: string | null, nowMs = Date.now()): string | null {
	const row = stmts().codeTake.get(code) as { user_id: string; expires_at: string } | undefined;
	if (!row || new Date(row.expires_at).getTime() < nowMs) return null;
	getDb().transaction(() => {
		stmts().linkDeleteChat.run(chatId, row.user_id);
		stmts().linkUpsert.run(row.user_id, chatId, username);
	})();
	return row.user_id;
}

export function unlink(userId: string): void {
	stmts().linkDelete.run(userId);
}

export function setLinkFlags(userId: string, flags: { urgent?: boolean; paused?: boolean }): void {
	const v = (b: boolean | undefined) => (b === undefined ? null : b ? 1 : 0);
	stmts().linkSet.run(v(flags.urgent), v(flags.paused), userId);
}

export function createButton(token: ButtonToken): string {
	stmts().buttonPrune.run(`-${BUTTON_TTL_DAYS} days`);
	const id = randomBytes(12).toString('base64url');
	stmts().buttonInsert.run(id, token.userId, token.accountId, token.emailId, token.action);
	return id;
}

/** A button press, once: null when unknown, used already, or too old. */
export function takeButton(id: string): ButtonToken | null {
	const row = stmts().buttonTake.get(id, `-${BUTTON_TTL_DAYS} days`) as
		| { user_id: string; account_id: string; email_id: string; action: ButtonToken['action'] }
		| undefined;
	return row ? { userId: row.user_id, accountId: row.account_id, emailId: row.email_id, action: row.action } : null;
}

export function addReminder(input: Omit<AgentReminder, 'id'>): string {
	const id = randomUUID();
	stmts().reminderInsert.run(id, input.userId, input.accountId, input.emailId, input.text, input.dueAt);
	return id;
}

export function dueReminders(nowMs = Date.now()): AgentReminder[] {
	return (stmts().remindersDue.all(new Date(nowMs).toISOString()) as {
		id: string;
		user_id: string;
		account_id: string | null;
		email_id: string | null;
		text: string;
		due_at: string;
	}[]).map((r) => ({ id: r.id, userId: r.user_id, accountId: r.account_id, emailId: r.email_id, text: r.text, dueAt: r.due_at }));
}

/** Claim a due reminder for sending, once. */
export function markReminderSent(id: string): boolean {
	return stmts().reminderSent.run(id).changes === 1;
}

export function getState(key: string): string | null {
	return (stmts().stateGet.get(key) as { value: string } | undefined)?.value ?? null;
}

export function setState(key: string, value: string): void {
	stmts().stateSet.run(key, value);
}
