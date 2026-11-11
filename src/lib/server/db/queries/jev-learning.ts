import { getDb } from '../index';
import { isInboxCategory, INBOX_CATEGORIES, type InboxCategory } from '$lib/types/categories';

/**
 * What Jev learns from you: sender pins and your moves between tabs. See
 * migration 014_jev_learning.sql.
 */

export interface SenderPin {
	/** A lowercased address, or `@domain`. */
	sender: string;
	category: InboxCategory;
	createdAt: number;
}

let _stmts: ReturnType<typeof prepareStmts> | null = null;

/** Prepared lazily, as in the other query modules (see jev-settings.ts). */
function prepareStmts() {
	const db = getDb();
	return {
		listPins: db.prepare(
			`SELECT sender, category, created_at FROM jev_sender_pins WHERE account_id = ? ORDER BY sender`
		),
		getPin: db.prepare(`SELECT category FROM jev_sender_pins WHERE account_id = ? AND sender = ?`),
		setPin: db.prepare(
			`INSERT INTO jev_sender_pins (account_id, sender, category, created_at) VALUES (?, ?, ?, ?)
			 ON CONFLICT (account_id, sender) DO UPDATE SET category = excluded.category`
		),
		deletePin: db.prepare(`DELETE FROM jev_sender_pins WHERE account_id = ? AND sender = ?`),
		addMove: db.prepare(
			`INSERT INTO jev_sender_moves (account_id, sender, category, moves, last_moved_at) VALUES (?, ?, ?, 1, ?)
			 ON CONFLICT (account_id, sender, category) DO UPDATE SET
			   moves = moves + 1, last_moved_at = excluded.last_moved_at`
		),
		forgetMove: db.prepare(
			`UPDATE jev_sender_moves SET moves = moves - 1
			 WHERE account_id = ? AND sender = ? AND category = ?`
		),
		pruneMoves: db.prepare(`DELETE FROM jev_sender_moves WHERE account_id = ? AND moves <= 0`),
		moves: db.prepare(
			`SELECT category, moves FROM jev_sender_moves
			 WHERE account_id = ? AND sender = ? ORDER BY moves DESC, last_moved_at DESC`
		)
	};
}
function stmts() {
	return (_stmts ??= prepareStmts());
}

/**
 * A pin key: a lowercased address, or `@domain` for a whole domain. Null
 * for anything that is neither.
 */
export function normalizePinSender(raw: string): string | null {
	const value = raw.trim().toLowerCase();
	if (/^@[a-z0-9.-]+\.[a-z]{2,}$/.test(value)) return value;
	if (/^[^\s@]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(value)) return value;
	return null;
}

export function listPins(accountId: string): SenderPin[] {
	return (stmts().listPins.all(accountId) as { sender: string; category: string; created_at: number }[])
		.filter((r) => isInboxCategory(r.category))
		.map((r) => ({ sender: r.sender, category: r.category as InboxCategory, createdAt: r.created_at }));
}

/** The pin deciding mail from `address`: its own, else its domain's. */
export function pinFor(pins: SenderPin[], address: string): SenderPin | null {
	const sender = address.trim().toLowerCase();
	const domain = sender.includes('@') ? `@${sender.split('@')[1]}` : null;
	return pins.find((p) => p.sender === sender) ?? (domain ? pins.find((p) => p.sender === domain) : undefined) ?? null;
}

export function getPinCategory(accountId: string, sender: string): InboxCategory | null {
	const row = stmts().getPin.get(accountId, sender) as { category: string } | undefined;
	return row && isInboxCategory(row.category) ? row.category : null;
}

export function setPin(accountId: string, sender: string, category: InboxCategory, now = Date.now()): void {
	stmts().setPin.run(accountId, sender, category, now);
}

export function deletePin(accountId: string, sender: string): void {
	stmts().deletePin.run(accountId, sender);
}

/** You moved mail from these senders to `category`: one count each. */
export function recordSenderMoves(accountId: string, senders: string[], category: InboxCategory, now = Date.now()): void {
	const s = stmts();
	getDb().transaction(() => {
		for (const sender of senders) s.addMove.run(accountId, sender, category, now);
	})();
}

/** Take back moves you undid, so an undone mistake doesn't become a habit. */
export function forgetSenderMoves(accountId: string, senders: string[], category: InboxCategory): void {
	const s = stmts();
	getDb().transaction(() => {
		for (const sender of senders) s.forgetMove.run(accountId, sender, category);
		s.pruneMoves.run(accountId);
	})();
}

/**
 * Your history with a sender, as the sentence Jev is sent — "You have moved
 * 3 earlier emails from this sender to Updates and 1 to Important." — or
 * null when you never moved its mail.
 */
export function senderHistory(accountId: string, sender: string): string | null {
	const rows = (stmts().moves.all(accountId, sender) as { category: string; moves: number }[]).filter((r) =>
		isInboxCategory(r.category)
	);
	if (rows.length === 0) return null;
	const label = (key: string) => INBOX_CATEGORIES.find((c) => c.key === key)?.label ?? key;
	const parts = rows.map((r, i) =>
		i === 0
			? `${r.moves} earlier email${r.moves === 1 ? '' : 's'} from this sender to ${label(r.category)}`
			: `${r.moves} to ${label(r.category)}`
	);
	return `You have moved ${parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`}.`;
}
