import { randomUUID } from 'node:crypto';
import { getDb } from '../db/index';
import { encryptSecret, decryptSecret } from './crypto';
import { authenticate } from '$lib/jmap/auth';
import type { AuthState } from '$lib/jmap/types';
import type { LinkedAccount } from '$lib/types/accounts';
import { errorFields, logEvent } from '$lib/server/log';

/**
 * Linked Stalwart mail accounts. Each row stores the account's password
 * encrypted (see crypto.ts), so the app can rebuild a JMAP `AuthState`
 * for any account at any time — request handling, account switching, and
 * background schedulers all flow through {@link authStateForAccount}.
 *
 * `AuthState` keeps its original shape on purpose: the 50+ API routes,
 * the JMAP/CalDAV clients, and every per-`user_email` SQLite table are
 * untouched by the multi-account refactor.
 */

export interface MailAccountRow {
	id: string;
	user_id: string;
	email: string;
	server_url: string;
	jmap_account_id: string;
	secret_enc: string;
	display_name: string | null;
	color: string;
	sort_order: number;
	needs_reauth: number;
	avatar_data: string | null;
}

/** Safe to ship to the client — no secret material. */
export type MailAccountPublic = LinkedAccount;

let _stmts: ReturnType<typeof prepareStmts> | null = null;
function prepareStmts() {
	const db = getDb();
	return {
		insert: db.prepare(
			`INSERT INTO mail_accounts
			   (id, user_id, email, server_url, jmap_account_id, secret_enc, display_name, color, sort_order, last_verified_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
		),
		listForUser: db.prepare(
			`SELECT * FROM mail_accounts WHERE user_id = ? ORDER BY sort_order, created_at`
		),
		listAll: db.prepare(`SELECT * FROM mail_accounts ORDER BY sort_order, created_at`),
		get: db.prepare(`SELECT * FROM mail_accounts WHERE id = ?`),
		// Scoped to the login: re-linking refreshes only an account this
		// login already has, never another login's row with the same address.
		byEmailForUser: db.prepare(`SELECT * FROM mail_accounts WHERE email = ? AND user_id = ?`),
		remove: db.prepare(`DELETE FROM mail_accounts WHERE id = ? AND user_id = ?`),
		maxSort: db.prepare(
			`SELECT COALESCE(MAX(sort_order), -1) AS m FROM mail_accounts WHERE user_id = ?`
		),
		setSort: db.prepare(`UPDATE mail_accounts SET sort_order = ? WHERE id = ? AND user_id = ?`),
		setColor: db.prepare(`UPDATE mail_accounts SET color = ? WHERE id = ? AND user_id = ?`),
		setDisplayName: db.prepare(
			`UPDATE mail_accounts SET display_name = ? WHERE id = ? AND user_id = ?`
		),
		setAvatar: db.prepare(
			`UPDATE mail_accounts SET avatar_data = ? WHERE id = ? AND user_id = ?`
		),
		getAvatar: db.prepare(`SELECT avatar_data FROM mail_accounts WHERE id = ?`),
		setReauth: db.prepare(`UPDATE mail_accounts SET needs_reauth = ? WHERE id = ?`),
		flagReauth: db.prepare(`UPDATE mail_accounts SET needs_reauth = 1 WHERE id = ? AND needs_reauth = 0`),
		updateSecret: db.prepare(
			`UPDATE mail_accounts
			 SET secret_enc = ?, jmap_account_id = ?, needs_reauth = 0, last_verified_at = datetime('now')
			 WHERE id = ?`
		),
		// A re-link that verified against another server moves the account
		// there too; keeping the old URL with the new server's account id
		// broke the account until the next re-auth.
		relink: db.prepare(
			`UPDATE mail_accounts
			 SET secret_enc = ?, jmap_account_id = ?, server_url = ?, needs_reauth = 0,
			     last_verified_at = datetime('now')
			 WHERE id = ? AND user_id = ?`
		)
	};
}
function stmts() {
	return (_stmts ??= prepareStmts());
}

/** Trim trailing slashes; default the scheme to https when omitted. */
export function normalizeServerUrl(input: string): string {
	let url = input.trim().replace(/\/+$/, '');
	if (url && !/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = `https://${url}`;
	return url;
}

/**
 * Operator-actionable description of a non-auth linking failure. Node's
 * fetch wraps the interesting part (DNS, refused connection, TLS) in
 * `cause`; configuration errors carry their own clear message.
 */
export function describeLinkError(err: unknown, serverUrl: string): string {
	const message = err instanceof Error ? err.message : String(err);
	if (message.includes('WEBMAIL_SECRET')) return message;
	const cause = (err as { cause?: unknown }).cause;
	const causeMsg =
		cause instanceof Error
			? cause.message || (cause as NodeJS.ErrnoException).code
			: undefined;
	return `Unable to reach the mail server at ${serverUrl} (${causeMsg ?? message})`;
}

export function toPublic(row: MailAccountRow): MailAccountPublic {
	return {
		id: row.id,
		email: row.email,
		displayName: row.display_name,
		color: row.color,
		needsReauth: row.needs_reauth === 1
	};
}

/**
 * Verify the credentials against the mail server, then store them
 * encrypted. Throws `JMAPAuthError` for bad credentials (caller maps it
 * to a friendly message).
 */
export async function linkAccount(opts: {
	userId: string;
	email: string;
	password: string;
	serverUrl: string;
	color: string;
	displayName?: string;
}): Promise<MailAccountPublic> {
	const email = opts.email.trim().toLowerCase();
	const auth = await authenticate(opts.serverUrl, email, opts.password);

	const existing = stmts().byEmailForUser.get(email, opts.userId) as MailAccountRow | undefined;
	if (existing) {
		// Re-linking an existing account refreshes its credentials in place.
		stmts().relink.run(encryptSecret(opts.password), auth.accountId, opts.serverUrl, existing.id, opts.userId);
		return toPublic({ ...existing, server_url: opts.serverUrl, needs_reauth: 0 });
	}

	const id = randomUUID();
	const sort = (stmts().maxSort.get(opts.userId) as { m: number }).m + 1;
	stmts().insert.run(
		id,
		opts.userId,
		email,
		opts.serverUrl,
		auth.accountId,
		encryptSecret(opts.password),
		opts.displayName ?? null,
		opts.color,
		sort
	);
	return {
		id,
		email,
		displayName: opts.displayName ?? null,
		color: opts.color,
		needsReauth: false
	};
}

export function listAccounts(userId: string): MailAccountRow[] {
	return stmts().listForUser.all(userId) as MailAccountRow[];
}

/** All linked accounts across users — what the background schedulers iterate. */
export function listAllMailAccounts(): MailAccountRow[] {
	return stmts().listAll.all() as MailAccountRow[];
}

export function getAccount(id: string): MailAccountRow | undefined {
	return stmts().get.get(id) as MailAccountRow | undefined;
}

export function removeAccount(userId: string, id: string): void {
	stmts().remove.run(id, userId);
}

export function reorderAccounts(userId: string, orderedIds: string[]): void {
	const tx = getDb().transaction(() => {
		orderedIds.forEach((id, i) => stmts().setSort.run(i, id, userId));
	});
	tx();
}

export function setAccountColor(userId: string, id: string, color: string): void {
	stmts().setColor.run(color, id, userId);
}

/**
 * Rename a linked account. An empty name clears the override, so the UI falls
 * back to the address rather than showing a blank row.
 */
export function setAccountDisplayName(userId: string, id: string, displayName: string): void {
	const trimmed = displayName.trim();
	stmts().setDisplayName.run(trimmed === '' ? null : trimmed, id, userId);
}

/**
 * Store an account's avatar as a data: URL, matching the personal avatar's
 * contract so the client can reuse the same compressor.
 *
 * Read back via {@link getAccountAvatar} and served from its own endpoint —
 * never through `toPublic()`, whose output is embedded in every page's server
 * payload, where image bytes would be re-sent on every navigation.
 */
export function setAccountAvatar(userId: string, id: string, dataUrl: string): void {
	stmts().setAvatar.run(dataUrl, id, userId);
}

export function clearAccountAvatar(userId: string, id: string): void {
	stmts().setAvatar.run(null, id, userId);
}

export function getAccountAvatar(id: string): string | null {
	const row = stmts().getAvatar.get(id) as { avatar_data: string | null } | undefined;
	return row?.avatar_data ?? null;
}

/**
 * Flag set when the mail server rejects the stored credentials (password
 * changed). Every background pass for the account stops, urgent alerts
 * included, so the change is logged and sent to Telegram, once: several
 * passes can hit the same 401, and only the first one flips the flag.
 */
export function markNeedsReauth(id: string): void {
	if (stmts().flagReauth.run(id).changes !== 1) return;
	logEvent('error', 'auth', 'needs_reauth', { account: id });
	// Imported here: the notifier itself imports this module.
	void import('$lib/server/telegram/notifier')
		.then(({ notifySignInLost }) => notifySignInLost(id))
		.catch((err) => logEvent('error', 'telegram', 'reauth_notice_failed', { account: id, ...errorFields(err) }));
}

/** Re-verify and refresh stored credentials for an account flagged needs_reauth. */
export async function reauthAccount(account: MailAccountRow, password: string): Promise<void> {
	const auth = await authenticate(account.server_url, account.email, password);
	stmts().updateSecret.run(encryptSecret(password), auth.accountId, account.id);
}

/**
 * What the background schedulers iterate: a ready-to-use auth per linked
 * account, across all users, skipping accounts whose credentials are
 * known-bad or undecryptable (rotated WEBMAIL_SECRET).
 */
export function listSchedulableAuths(): Array<{
	account: MailAccountRow;
	auth: AuthState;
	email: string;
}> {
	const out: Array<{ account: MailAccountRow; auth: AuthState; email: string }> = [];
	for (const account of listAllMailAccounts()) {
		if (account.needs_reauth === 1) continue;
		try {
			out.push({ account, auth: authStateForAccount(account), email: account.email });
		} catch {
			// Undecryptable secret — skip until the user re-links the account.
		}
	}
	return out;
}

/**
 * Rebuild the request-scoped `AuthState` from stored credentials — no
 * round-trip to the mail server (the JMAP account id is cached on the row).
 */
export function authStateForAccount(account: MailAccountRow): AuthState {
	const password = decryptSecret(account.secret_enc);
	const authHeader = `Basic ${Buffer.from(`${account.email}:${password}`).toString('base64')}`;
	return {
		authHeader,
		accountId: account.jmap_account_id,
		apiUrl: `${account.server_url}/jmap/`,
		sessionState: ''
	};
}
