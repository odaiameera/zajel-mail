import { randomBytes, randomUUID } from 'node:crypto';
import { getDb } from '../db/index';

/** Telegram links, link codes, button tokens and agent reminders. See migration 022. */

const CODE_TTL_MS = 10 * 60 * 1000;
const BUTTON_TTL_DAYS = 7;
/** A sent (or given-up) reminder stays this long, then goes. */
const REMINDER_KEEP_DAYS = 30;

export interface TelegramLink {
	userId: string;
	chatId: string;
	username: string | null;
	urgent: boolean;
	paused: boolean;
	/** The chat's running conversation with Zajel; /new starts another. */
	conversationId: string | null;
	/** The user's clock, from the browser that linked the chat or last used Zajel. */
	timeZone: string | null;
	/** Emails, invitations and deletions Zajel prepares can be confirmed with a button here. */
	confirmInChat: boolean;
}

/** What a button on one of Zajel's chat messages does, and to what. */
export interface AgentButton {
	userId: string;
	accountId: string;
	kind: 'confirm' | 'cancel' | 'undo_send' | 'send_draft' | 'draft_reply';
	/** The pending action, scheduled message, draft or email it acts on. */
	ref: string;
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
			 WHERE sent_at IS NULL AND due_at <= @now AND (claimed_at IS NULL OR claimed_at < @stale)
			 ORDER BY due_at LIMIT 50`
		),
		reminderClaim: db.prepare(
			`UPDATE agent_reminders SET claimed_at = @now
			 WHERE id = @id AND sent_at IS NULL AND (claimed_at IS NULL OR claimed_at < @stale)`
		),
		reminderSent: db.prepare(`UPDATE agent_reminders SET sent_at = datetime('now'), claimed_at = NULL WHERE id = ?`),
		reminderRelease: db.prepare(`UPDATE agent_reminders SET claimed_at = NULL WHERE id = ?`),
		reminderPrune: db.prepare(`DELETE FROM agent_reminders WHERE sent_at IS NOT NULL AND sent_at < datetime('now', ?)`),
		buttonRelease: db.prepare(`UPDATE telegram_buttons SET used_at = NULL WHERE id = ?`),
		stateGet: db.prepare(`SELECT value FROM telegram_state WHERE key = ?`),
		stateSet: db.prepare(
			`INSERT INTO telegram_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`
		)
	};
}
function stmts() {
	return (_stmts ??= prepareStmts());
}

// Chatting with Zajel (migration 033), apart from the rest like the outbox
// below: without it, links, alert buttons and reminders still work.
let _chat: ReturnType<typeof prepareChat> | null = null;
function prepareChat() {
	const db = getDb();
	return {
		codeInsert: db.prepare(`INSERT INTO telegram_link_codes (code, user_id, expires_at, time_zone) VALUES (?, ?, ?, ?)`),
		codeTake: db.prepare(`DELETE FROM telegram_link_codes WHERE code = ? RETURNING user_id, expires_at, time_zone`),
		linkTimeZone: db.prepare(`UPDATE telegram_links SET time_zone = ? WHERE user_id = ? AND time_zone IS NOT ?`),
		linkConversation: db.prepare(`UPDATE telegram_links SET conversation_id = ? WHERE user_id = ?`),
		linkConfirm: db.prepare(`UPDATE telegram_links SET confirm_in_chat = ? WHERE user_id = ?`),
		buttonInsert: db.prepare(`INSERT INTO telegram_agent_buttons (id, user_id, account_id, kind, ref) VALUES (?, ?, ?, ?, ?)`),
		buttonTake: db.prepare(
			`UPDATE telegram_agent_buttons SET used_at = datetime('now')
			 WHERE id = ? AND used_at IS NULL AND created_at > datetime('now', ?)
			 RETURNING user_id, account_id, kind, ref`
		),
		buttonRelease: db.prepare(`UPDATE telegram_agent_buttons SET used_at = NULL WHERE id = ?`),
		buttonPrune: db.prepare(`DELETE FROM telegram_agent_buttons WHERE created_at < datetime('now', ?)`)
	};
}
function chat() {
	return (_chat ??= prepareChat());
}

// Apart from the rest, so that if migration 025 ever failed to apply, only
// urgent-alert queueing would break, not links, buttons or reminders.
let _outbox: ReturnType<typeof prepareOutbox> | null = null;
function prepareOutbox() {
	const db = getDb();
	return {
		queue: db.prepare(
			`INSERT INTO telegram_outbox (id, kind, user_id, account_id, email_id, html, summary, next_attempt_at, created_at)
			 VALUES (@id, @kind, @userId, @accountId, @emailId, @html, @summary, @now, @now)
			 ON CONFLICT (account_id, email_id) DO NOTHING`
		),
		due: db.prepare(
			`SELECT id, kind, user_id, account_id, email_id, html, summary, attempts, created_at FROM telegram_outbox
			 WHERE done_at IS NULL AND next_attempt_at <= ? AND (? IS NULL OR user_id = ?)
			 ORDER BY created_at LIMIT 20`
		),
		done: db.prepare(
			`UPDATE telegram_outbox SET done_at = ?, outcome = ?, html = NULL, summary = NULL WHERE id = ? AND done_at IS NULL`
		),
		failedLater: db.prepare(`UPDATE telegram_outbox SET attempts = attempts + 1, next_attempt_at = ? WHERE id = ?`),
		holdUntil: db.prepare(`UPDATE telegram_outbox SET next_attempt_at = ? WHERE id = ?`),
		claim: db.prepare(
			`UPDATE telegram_outbox SET next_attempt_at = ? WHERE id = ? AND done_at IS NULL AND next_attempt_at <= ?`
		),
		prune: db.prepare(`DELETE FROM telegram_outbox WHERE created_at < ?`)
	};
}
function outbox() {
	return (_outbox ??= prepareOutbox());
}

type LinkRow = {
	user_id: string;
	chat_id: string;
	username: string | null;
	urgent: number;
	paused: number;
	conversation_id: string | null;
	time_zone: string | null;
	confirm_in_chat: number;
};
const toLink = (row: LinkRow): TelegramLink => ({
	userId: row.user_id,
	chatId: row.chat_id,
	username: row.username,
	urgent: row.urgent === 1,
	paused: row.paused === 1,
	conversationId: row.conversation_id,
	timeZone: row.time_zone,
	confirmInChat: row.confirm_in_chat === 1
});

export function getLink(userId: string): TelegramLink | null {
	const row = stmts().linkGet.get(userId) as LinkRow | undefined;
	return row ? toLink(row) : null;
}

export function getLinkByChat(chatId: string): TelegramLink | null {
	const row = stmts().linkByChat.get(chatId) as LinkRow | undefined;
	return row ? toLink(row) : null;
}

/**
 * A fresh single-use code for the t.me link; the caller has re-checked
 * already. `timeZone` is the linking browser's, for the chat to answer in.
 */
export function createLinkCode(userId: string, nowMs = Date.now(), timeZone: string | null = null): string {
	stmts().codePrune.run(new Date(nowMs).toISOString());
	const code = randomBytes(18).toString('base64url');
	chat().codeInsert.run(code, userId, new Date(nowMs + CODE_TTL_MS).toISOString(), timeZone);
	return code;
}

/**
 * Bind the chat that sent a valid /start code. The code is spent whatever
 * happens; a chat can belong to only one login.
 */
export function linkChatWithCode(code: string, chatId: string, username: string | null, nowMs = Date.now()): string | null {
	const row = chat().codeTake.get(code) as { user_id: string; expires_at: string; time_zone: string | null } | undefined;
	if (!row || new Date(row.expires_at).getTime() < nowMs) return null;
	getDb().transaction(() => {
		stmts().linkDeleteChat.run(chatId, row.user_id);
		stmts().linkUpsert.run(row.user_id, chatId, username);
		if (row.time_zone) chat().linkTimeZone.run(row.time_zone, row.user_id, row.time_zone);
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

/** The user's clock as the web app last saw it; a no-op without a link. */
export function noteTimeZone(userId: string, timeZone: string): void {
	chat().linkTimeZone.run(timeZone, userId, timeZone);
}

export function setLinkConversation(userId: string, conversationId: string): void {
	chat().linkConversation.run(conversationId, userId);
}

export function setConfirmInChat(userId: string, on: boolean): void {
	chat().linkConfirm.run(on ? 1 : 0, userId);
}

export function createAgentButton(button: AgentButton): string {
	chat().buttonPrune.run(`-${BUTTON_TTL_DAYS} days`);
	const id = randomBytes(12).toString('base64url');
	chat().buttonInsert.run(id, button.userId, button.accountId, button.kind, button.ref);
	return id;
}

/** A press on one of Zajel's chat buttons, once: null when unknown, used already, or too old. */
export function takeAgentButton(id: string): AgentButton | null {
	const row = chat().buttonTake.get(id, `-${BUTTON_TTL_DAYS} days`) as
		| { user_id: string; account_id: string; kind: AgentButton['kind']; ref: string }
		| undefined;
	return row ? { userId: row.user_id, accountId: row.account_id, kind: row.kind, ref: row.ref } : null;
}

/** Make a button usable again: what it does didn't happen. */
export function releaseAgentButton(id: string): void {
	chat().buttonRelease.run(id);
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

// Long enough to cover one send (Telegram calls time out at 15 s).
const CLAIM_MS = 2 * 60_000;

const claimWindow = (nowMs: number) => ({ now: new Date(nowMs).toISOString(), stale: new Date(nowMs - CLAIM_MS).toISOString() });

export function dueReminders(nowMs = Date.now()): AgentReminder[] {
	stmts().reminderPrune.run(`-${REMINDER_KEEP_DAYS} days`);
	return (stmts().remindersDue.all(claimWindow(nowMs)) as {
		id: string;
		user_id: string;
		account_id: string | null;
		email_id: string | null;
		text: string;
		due_at: string;
	}[]).map((r) => ({ id: r.id, userId: r.user_id, accountId: r.account_id, emailId: r.email_id, text: r.text, dueAt: r.due_at }));
}

/** Claim a due reminder for sending, once. */
/**
 * Take a due reminder for sending. The claim lapses after a couple of
 * minutes, so a reminder whose send died with the process goes out later.
 */
export function claimReminder(id: string, nowMs = Date.now()): boolean {
	return stmts().reminderClaim.run({ id, ...claimWindow(nowMs) }).changes === 1;
}

/** Delivered, or given up on: either way it isn't sent again. */
export function markReminderSent(id: string): void {
	stmts().reminderSent.run(id);
}

/** Give a claimed reminder back, so the next minute's run tries it again. */
export function releaseReminder(id: string): void {
	stmts().reminderRelease.run(id);
}

export interface QueuedAlert {
	id: string;
	/** urgent: an email, with its buttons; notice: from Zajel itself, plain. */
	kind: 'urgent' | 'notice';
	userId: string;
	accountId: string;
	emailId: string;
	html: string;
	summary: string;
	attempts: number;
	createdAt: string;
}

const ALERT_KEEP_MS = 7 * 86_400_000;

/** Queue an alert. False when the same one (account and email, or notice key) was already queued or sent. */
export function queueAlert(
	alert: Omit<QueuedAlert, 'id' | 'attempts' | 'createdAt' | 'kind'> & { kind?: QueuedAlert['kind'] },
	nowMs = Date.now()
): boolean {
	const now = new Date(nowMs).toISOString();
	outbox().prune.run(new Date(nowMs - ALERT_KEEP_MS).toISOString());
	return outbox().queue.run({ id: randomBytes(12).toString('base64url'), kind: 'urgent', ...alert, now }).changes === 1;
}

/** Alerts due to be sent, oldest first; for one login, or everyone. */
export function dueAlerts(userId: string | null, nowMs = Date.now()): QueuedAlert[] {
	const rows = outbox().due.all(new Date(nowMs).toISOString(), userId, userId) as {
		id: string;
		kind: string;
		user_id: string;
		account_id: string;
		email_id: string;
		html: string;
		summary: string | null;
		attempts: number;
		created_at: string;
	}[];
	return rows.map((r) => ({
		id: r.id,
		kind: r.kind === 'notice' ? 'notice' : 'urgent',
		userId: r.user_id,
		accountId: r.account_id,
		emailId: r.email_id,
		html: r.html,
		summary: r.summary ?? '',
		attempts: r.attempts,
		createdAt: r.created_at
	}));
}

/** Done with an alert: sent, or given up. False when another run got there first. */
export function finishAlert(id: string, outcome: 'sent' | 'refused' | 'expired' | 'dropped', nowMs = Date.now()): boolean {
	return outbox().done.run(new Date(nowMs).toISOString(), outcome, id).changes === 1;
}

/** After a failed send: counts as an attempt, which sets the next backoff. */
export function retryAlertAt(id: string, atMs: number): void {
	outbox().failedLater.run(new Date(atMs).toISOString(), id);
}

/** Held back (the hourly cap), which isn't a failed attempt. */
export function holdAlertUntil(id: string, atMs: number): void {
	outbox().holdUntil.run(new Date(atMs).toISOString(), id);
}

// Long enough to cover one send (Telegram calls time out at 15 s).
const ALERT_LEASE_MS = 2 * 60_000;

/**
 * Take a due alert for sending, so two runs at once (two accounts' Jev
 * passes, or a pass and the minute cron) can't both send it. A run that dies
 * mid-send leaves it to be retried when the lease runs out.
 */
export function claimAlert(id: string, nowMs = Date.now()): boolean {
	const now = new Date(nowMs).toISOString();
	return outbox().claim.run(new Date(nowMs + ALERT_LEASE_MS).toISOString(), id, now).changes === 1;
}

/** Make a pressed button usable again, after its action failed. */
export function releaseButton(id: string): void {
	stmts().buttonRelease.run(id);
}

export function getState(key: string): string | null {
	return (stmts().stateGet.get(key) as { value: string } | undefined)?.value ?? null;
}

export function setState(key: string, value: string): void {
	stmts().stateSet.run(key, value);
}
