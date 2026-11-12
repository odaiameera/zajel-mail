import { randomUUID } from 'crypto';
import { getDb } from '../index';

/**
 * Storage for the agent panel's chat sessions.
 *
 * Every read and write is scoped by user_email. The conversation id is a
 * UUID, but it is never the only thing authorising access — an id belonging
 * to another account must not resolve, so ownership is part of the WHERE
 * clause rather than something the caller is trusted to have checked.
 */

/** How long a conversation survives after its last message. */
export const AI_HISTORY_RETENTION_DAYS = 7;

const RETENTION_MS = AI_HISTORY_RETENTION_DAYS * 86_400_000;

/** Enough to identify a session in a list without loading its messages. */
export interface ConversationSummary {
	id: string;
	title: string;
	createdAt: number;
	updatedAt: number;
	messageCount: number;
}

export interface StoredMessage {
	id: number;
	role: 'user' | 'assistant';
	content: string;
	createdAt: number;
}

let _stmts: ReturnType<typeof prepareStmts> | null = null;

/**
 * Prepared lazily for the same reason as the other query modules here:
 * preparing at module scope would open the database during `vite build`'s
 * SSR pass, before migrations have run.
 */
function prepareStmts() {
	const db = getDb();
	return {
		insertConversation: db.prepare(
			`INSERT INTO ai_conversations (id, user_email, title, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?)`
		),
		listConversations: db.prepare(
			`SELECT c.id,
			        c.title,
			        c.created_at AS createdAt,
			        c.updated_at AS updatedAt,
			        COUNT(m.id) AS messageCount
			 FROM ai_conversations c
			 LEFT JOIN ai_messages m ON m.conversation_id = c.id
			 WHERE c.user_email = ?
			 GROUP BY c.id
			 HAVING messageCount > 0
			 ORDER BY c.updated_at DESC
			 LIMIT ?`
		),
		ownedConversation: db.prepare(
			`SELECT id FROM ai_conversations WHERE id = ? AND user_email = ?`
		),
		listMessages: db.prepare(
			`SELECT m.id, m.role, m.content, m.created_at AS createdAt
			 FROM ai_messages m
			 JOIN ai_conversations c ON c.id = m.conversation_id
			 WHERE m.conversation_id = ? AND c.user_email = ?
			 ORDER BY m.id ASC`
		),
		insertMessage: db.prepare(
			`INSERT INTO ai_messages (conversation_id, role, content, created_at)
			 VALUES (?, ?, ?, ?)`
		),
		touchConversation: db.prepare(
			`UPDATE ai_conversations SET updated_at = ? WHERE id = ? AND user_email = ?`
		),
		setTitleIfEmpty: db.prepare(
			`UPDATE ai_conversations SET title = ?
			 WHERE id = ? AND user_email = ? AND title = ''`
		),
		deleteConversation: db.prepare(
			`DELETE FROM ai_conversations WHERE id = ? AND user_email = ?`
		),
		pruneExpired: db.prepare(`DELETE FROM ai_conversations WHERE updated_at < ?`)
	};
}

function stmts() {
	if (!_stmts) _stmts = prepareStmts();
	return _stmts;
}

/** Reset the prepared-statement cache. Tests swap the database underneath. */
export function resetConversationStatements(): void {
	_stmts = null;
}

/**
 * Drop conversations whose last activity is outside the retention window.
 * Messages go with them through ON DELETE CASCADE.
 */
export function pruneExpiredConversations(now = Date.now()): number {
	return stmts().pruneExpired.run(now - RETENTION_MS).changes;
}

/** First line of the opening message, as the session's label. */
export function titleFromMessage(message: string): string {
	const firstLine = message.trim().split('\n')[0]?.trim() ?? '';
	if (!firstLine) return 'New conversation';
	return firstLine.length > 60 ? `${firstLine.slice(0, 59)}…` : firstLine;
}

/** A new session; one given a `title` keeps it, otherwise its first message names it. */
export function createConversation(userEmail: string, now = Date.now(), title = ''): string {
	const id = randomUUID();
	stmts().insertConversation.run(id, userEmail, title, now, now);
	return id;
}

/**
 * Sessions for the panel's history list, newest first.
 *
 * Conversations with no messages are omitted: a session is created the moment
 * the panel opens a new chat, and one the user never typed into is not
 * history worth showing.
 */
export function listConversations(userEmail: string, limit = 50): ConversationSummary[] {
	pruneExpiredConversations();
	return stmts().listConversations.all(userEmail, limit) as ConversationSummary[];
}

export function conversationExists(id: string, userEmail: string): boolean {
	return !!stmts().ownedConversation.get(id, userEmail);
}

export function listMessages(id: string, userEmail: string): StoredMessage[] {
	return stmts().listMessages.all(id, userEmail) as StoredMessage[];
}

/**
 * Append one turn and mark the conversation active.
 *
 * Wrapped in a transaction so a conversation can never be left with a message
 * that its updated_at does not account for — that row would be pruned on a
 * schedule derived from stale activity.
 */
export function appendMessage(
	conversationId: string,
	userEmail: string,
	role: 'user' | 'assistant',
	content: string,
	now = Date.now()
): boolean {
	const db = getDb();
	const s = stmts();

	const write = db.transaction(() => {
		if (!s.ownedConversation.get(conversationId, userEmail)) return false;
		s.insertMessage.run(conversationId, role, content, now);
		s.touchConversation.run(now, conversationId, userEmail);
		if (role === 'user') {
			s.setTitleIfEmpty.run(titleFromMessage(content), conversationId, userEmail);
		}
		return true;
	});

	return write();
}

export function deleteConversation(id: string, userEmail: string): boolean {
	return stmts().deleteConversation.run(id, userEmail).changes > 0;
}
