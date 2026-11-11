import { getDb } from '../index';

/**
 * Colour, icon and display name for a folder or label, kept by mail account
 * (migration 031). Each value may be null, meaning none: the sidebar then
 * shows the default (a label's automatic colour, the plain folder icon, the
 * mailbox's own name).
 */
export interface MailboxMetaRow {
	mailboxId: string;
	color: string | null;
	icon: string | null;
	displayName: string | null;
}

/** A change: a value that is undefined is left as it is; null clears it. */
export interface MailboxMetaPatch {
	color?: string | null;
	icon?: string | null;
	displayName?: string | null;
}

let _stmts: ReturnType<typeof prepareStmts> | null = null;
function prepareStmts() {
	const db = getDb();
	const columns = `mailbox_id AS mailboxId, color, icon, display_name AS displayName`;
	return {
		list: db.prepare(`SELECT ${columns} FROM mailbox_meta WHERE account_id = ? ORDER BY mailbox_id`),
		get: db.prepare(`SELECT ${columns} FROM mailbox_meta WHERE account_id = ? AND mailbox_id = ?`),
		// Every value is written as given, so one can be set back to nothing.
		upsert: db.prepare(
			`INSERT INTO mailbox_meta (account_id, mailbox_id, color, icon, display_name)
			 VALUES (@accountId, @mailboxId, @color, @icon, @displayName)
			 ON CONFLICT (account_id, mailbox_id) DO UPDATE SET
			   color        = excluded.color,
			   icon         = excluded.icon,
			   display_name = excluded.display_name,
			   updated_at   = datetime('now')`
		),
		delete: db.prepare(`DELETE FROM mailbox_meta WHERE account_id = ? AND mailbox_id = ?`)
	};
}
function stmts() {
	return (_stmts ??= prepareStmts());
}

export function listMailboxMeta(accountId: string): MailboxMetaRow[] {
	return stmts().list.all(accountId) as MailboxMetaRow[];
}

export function getMailboxMeta(accountId: string, mailboxId: string): MailboxMetaRow | null {
	return (stmts().get.get(accountId, mailboxId) as MailboxMetaRow | undefined) ?? null;
}

/**
 * Change some of a mailbox's values and return what is stored now; null
 * when nothing is left, in which case the row is removed.
 */
export function setMailboxMeta(accountId: string, mailboxId: string, patch: MailboxMetaPatch): MailboxMetaRow | null {
	const db = getDb();
	return db.transaction(() => {
		const current = getMailboxMeta(accountId, mailboxId);
		const next = {
			color: patch.color !== undefined ? patch.color : (current?.color ?? null),
			icon: patch.icon !== undefined ? patch.icon : (current?.icon ?? null),
			displayName: patch.displayName !== undefined ? patch.displayName : (current?.displayName ?? null)
		};
		if (next.color === null && next.icon === null && next.displayName === null) {
			stmts().delete.run(accountId, mailboxId);
			return null;
		}
		stmts().upsert.run({ accountId, mailboxId, ...next });
		return { mailboxId, ...next };
	})();
}

export function deleteMailboxMeta(accountId: string, mailboxId: string): void {
	stmts().delete.run(accountId, mailboxId);
}
