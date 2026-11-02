import { getDb } from '$lib/server/db/index';

/**
 * The semantic search index in SQLite (migration 026). Per linked account:
 * one state row, one row per message (queued, embedded or given up on), and
 * the message's chunk vectors, which go when its row goes.
 */

export interface IndexState {
	accountId: string;
	enabled: boolean;
	model: string | null;
	dimensions: number | null;
	emailState: string | null;
	listCursor: string | null;
	listed: boolean;
	listGen: number;
	ready: boolean;
	lastError: string | null;
}

export interface IndexedEmail {
	id: string;
	receivedAt: string;
	mailboxIds: string[];
}

export interface StoredVector {
	scale: number;
	data: Int8Array;
}

export interface IndexProgress {
	total: number;
	done: number;
	failed: number;
	pending: number;
}

/** Embedding attempts before a message is skipped for good. */
export const MAX_ATTEMPTS = 3;

interface StateRow {
	account_id: string;
	enabled: number;
	model: string | null;
	dimensions: number | null;
	email_state: string | null;
	list_cursor: string | null;
	listed: number;
	list_gen: number;
	ready: number;
	last_error: string | null;
}

function toState(row: StateRow): IndexState {
	return {
		accountId: row.account_id,
		enabled: row.enabled === 1,
		model: row.model,
		dimensions: row.dimensions,
		emailState: row.email_state,
		listCursor: row.list_cursor,
		listed: row.listed === 1,
		listGen: row.list_gen,
		ready: row.ready === 1,
		lastError: row.last_error
	};
}

const COLUMNS: Record<keyof Omit<IndexState, 'accountId'>, string> = {
	enabled: 'enabled',
	model: 'model',
	dimensions: 'dimensions',
	emailState: 'email_state',
	listCursor: 'list_cursor',
	listed: 'listed',
	listGen: 'list_gen',
	ready: 'ready',
	lastError: 'last_error'
};

let _stmts: ReturnType<typeof prepareStmts> | null = null;

/** Prepared lazily, like the other query modules: not during `vite build`. */
function prepareStmts() {
	const db = getDb();
	return {
		get: db.prepare('SELECT * FROM search_index WHERE account_id = ?'),
		enabled: db.prepare('SELECT * FROM search_index WHERE enabled = 1'),
		upsertEmail: db.prepare(
			`INSERT INTO search_emails (account_id, email_id, received_at, mailbox_ids, list_gen)
			 VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT (account_id, email_id) DO UPDATE SET
			   received_at = excluded.received_at,
			   mailbox_ids = excluded.mailbox_ids,
			   list_gen = excluded.list_gen`
		),
		removeEmail: db.prepare('DELETE FROM search_emails WHERE account_id = ? AND email_id = ?'),
		exists: db.prepare('SELECT 1 FROM search_emails WHERE account_id = ? AND email_id = ?'),
		unseen: db.prepare('SELECT email_id FROM search_emails WHERE account_id = ? AND list_gen < ?'),
		removeUnseen: db.prepare('DELETE FROM search_emails WHERE account_id = ? AND list_gen < ?'),
		pending: db.prepare(
			`SELECT email_id FROM search_emails WHERE account_id = ? AND status = 'pending'
			 ORDER BY received_at DESC LIMIT ?`
		),
		clearVectors: db.prepare('DELETE FROM search_vectors WHERE account_id = ? AND email_id = ?'),
		insertVector: db.prepare(
			'INSERT INTO search_vectors (account_id, email_id, chunk, scale, vector) VALUES (?, ?, ?, ?, ?)'
		),
		markDone: db.prepare(
			`UPDATE search_emails SET status = 'done', attempts = attempts + 1 WHERE account_id = ? AND email_id = ?`
		),
		markAttempt: db.prepare(
			`UPDATE search_emails
			 SET attempts = attempts + 1,
			     status = CASE WHEN attempts + 1 >= ? THEN 'failed' ELSE status END
			 WHERE account_id = ? AND email_id = ?`
		),
		progress: db.prepare(
			`SELECT COUNT(*) AS total,
			        COALESCE(SUM(status = 'done'), 0) AS done,
			        COALESCE(SUM(status = 'failed'), 0) AS failed,
			        COALESCE(SUM(status = 'pending'), 0) AS pending
			 FROM search_emails WHERE account_id = ?`
		),
		dropVectors: db.prepare('DELETE FROM search_vectors WHERE account_id = ?'),
		requeueAll: db.prepare(`UPDATE search_emails SET status = 'pending', attempts = 0 WHERE account_id = ?`),
		dropEmails: db.prepare('DELETE FROM search_emails WHERE account_id = ?'),
		vectors: db.prepare(
			`SELECT v.email_id, v.scale, v.vector, e.received_at, e.mailbox_ids
			 FROM search_vectors v
			 JOIN search_emails e ON e.account_id = v.account_id AND e.email_id = v.email_id
			 WHERE v.account_id = ?
			 ORDER BY v.email_id, v.chunk`
		)
	};
}

function stmts() {
	return (_stmts ??= prepareStmts());
}

export function getIndexState(accountId: string): IndexState | null {
	const row = stmts().get.get(accountId) as StateRow | undefined;
	return row ? toState(row) : null;
}

export function enabledIndexes(): IndexState[] {
	return (stmts().enabled.all() as StateRow[]).map(toState);
}

/** Merge `patch` into the account's state row. */
export function updateIndexState(
	accountId: string,
	patch: Partial<Omit<IndexState, 'accountId'>>,
	now = Date.now()
): void {
	const entries = Object.entries(patch) as [keyof typeof COLUMNS, unknown][];
	if (entries.length === 0) return;
	const sets = entries.map(([key]) => `${COLUMNS[key]} = ?`).join(', ');
	const values = entries.map(([, value]) => (typeof value === 'boolean' ? (value ? 1 : 0) : value));
	getDb()
		.prepare(`UPDATE search_index SET ${sets}, updated_at = ? WHERE account_id = ?`)
		.run(...values, now, accountId);
}

/**
 * Switch the account's index on or off. On starts from nothing; off deletes
 * everything indexed, so switching it off is also how the index is removed.
 */
export function setIndexEnabled(accountId: string, enabled: boolean, now = Date.now()): void {
	const db = getDb();
	db.transaction(() => {
		const current = getIndexState(accountId);
		if (current?.enabled === enabled) return;
		stmts().dropVectors.run(accountId);
		stmts().dropEmails.run(accountId);
		db.prepare(
			`INSERT INTO search_index (account_id, enabled, updated_at) VALUES (?, ?, ?)
			 ON CONFLICT (account_id) DO UPDATE SET
			   enabled = excluded.enabled, model = NULL, dimensions = NULL, email_state = NULL,
			   list_cursor = NULL, listed = 0, list_gen = 0, ready = 0, last_error = NULL,
			   updated_at = excluded.updated_at`
		).run(accountId, enabled ? 1 : 0, now);
	})();
}

/** Queue messages, or refresh the date and mailboxes of ones already known. */
export function upsertEmails(accountId: string, emails: IndexedEmail[], gen: number): void {
	const stmt = stmts().upsertEmail;
	getDb().transaction(() => {
		for (const e of emails) stmt.run(accountId, e.id, e.receivedAt, e.mailboxIds.join(' '), gen);
	})();
}

export function removeEmails(accountId: string, ids: string[]): void {
	const stmt = stmts().removeEmail;
	getDb().transaction(() => {
		for (const id of ids) stmt.run(accountId, id);
	})();
}

/** After a full relisting: drop every message it didn't see, returning their ids. */
export function removeUnseen(accountId: string, gen: number): string[] {
	return getDb().transaction(() => {
		const ids = (stmts().unseen.all(accountId, gen) as { email_id: string }[]).map((r) => r.email_id);
		stmts().removeUnseen.run(accountId, gen);
		return ids;
	})();
}

/** Queued messages, newest first: recent mail becomes searchable first. */
export function pendingEmailIds(accountId: string, limit: number): string[] {
	return (stmts().pending.all(accountId, limit) as { email_id: string }[]).map((r) => r.email_id);
}

/** Replace a message's vectors and mark it embedded; false if it has left the index meanwhile. */
export function storeVectors(accountId: string, emailId: string, vectors: StoredVector[]): boolean {
	const s = stmts();
	return getDb().transaction(() => {
		if (!s.exists.get(accountId, emailId)) return false;
		s.clearVectors.run(accountId, emailId);
		vectors.forEach((v, chunk) =>
			s.insertVector.run(accountId, emailId, chunk, v.scale, Buffer.from(v.data.buffer, v.data.byteOffset, v.data.byteLength))
		);
		s.markDone.run(accountId, emailId);
		return true;
	})();
}

/** Count a failed attempt; the last one marks the message failed. */
export function recordAttempt(accountId: string, emailId: string): void {
	stmts().markAttempt.run(MAX_ATTEMPTS, accountId, emailId);
}

export function indexProgress(accountId: string): IndexProgress {
	return stmts().progress.get(accountId) as IndexProgress;
}

/** Vectors from another model don't compare: drop them and queue everything again. */
export function restartWithModel(accountId: string, model: string, now = Date.now()): void {
	getDb().transaction(() => {
		stmts().dropVectors.run(accountId);
		stmts().requeueAll.run(accountId);
		updateIndexState(accountId, { model, dimensions: null, ready: false, lastError: null }, now);
	})();
}

export interface VectorRow {
	emailId: string;
	receivedAt: string;
	mailboxIds: string[];
	vector: StoredVector;
}

/** Every stored vector for an account, grouped by message. */
export function* iterateVectors(accountId: string): Generator<VectorRow> {
	for (const row of stmts().vectors.iterate(accountId) as Iterable<{
		email_id: string;
		scale: number;
		vector: Buffer;
		received_at: string;
		mailbox_ids: string;
	}>) {
		yield {
			emailId: row.email_id,
			receivedAt: row.received_at,
			mailboxIds: row.mailbox_ids ? row.mailbox_ids.split(' ') : [],
			vector: {
				scale: row.scale,
				data: new Int8Array(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength)
			}
		};
	}
}
