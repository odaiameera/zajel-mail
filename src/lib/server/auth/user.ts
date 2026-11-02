import { randomUUID } from 'node:crypto';
import { getDb } from '../db/index';
import { hashPassword, verifyPassword } from './password';

export interface AppUser {
	id: string;
	email: string;
}

let _stmts: ReturnType<typeof prepareStmts> | null = null;
function prepareStmts() {
	const db = getDb();
	return {
		count: db.prepare(`SELECT COUNT(*) AS n FROM app_user`),
		byEmail: db.prepare(`SELECT id, email, password_hash FROM app_user WHERE email = ?`),
		byId: db.prepare(`SELECT id, email FROM app_user WHERE id = ?`),
		first: db.prepare(`SELECT id, email FROM app_user ORDER BY created_at LIMIT 1`),
		// The single master login is created in one statement, so two setup
		// submissions racing past hasAppUser() can't both insert a row.
		insert: db.prepare(
			`INSERT INTO app_user (id, email, password_hash)
			 SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM app_user)`
		),
		setPassword: db.prepare(
			`UPDATE app_user SET password_hash = ?, updated_at = datetime('now') WHERE id = ?`
		),
		getHash: db.prepare(`SELECT password_hash FROM app_user WHERE id = ?`)
	};
}
function stmts() {
	return (_stmts ??= prepareStmts());
}

/** True once /setup has been completed. Gates the first-run flow. */
export function hasAppUser(): boolean {
	return (stmts().count.get() as { n: number }).n > 0;
}

/** The new master login, or undefined when one already exists. */
export async function createAppUser(email: string, password: string): Promise<AppUser | undefined> {
	const id = randomUUID();
	const normalized = email.trim().toLowerCase();
	const hash = await hashPassword(password);
	if (stmts().insert.run(id, normalized, hash).changes !== 1) return undefined;
	return { id, email: normalized };
}

export function getUserById(id: string): AppUser | undefined {
	return stmts().byId.get(id) as AppUser | undefined;
}

/** The sole webmail user — used for usernameless passkey login. */
export function getFirstUser(): AppUser | undefined {
	return stmts().first.get() as AppUser | undefined;
}

// Hashed once and reused: an unknown email then costs one verify, exactly
// like a known one with a wrong password. Hashing it on every attempt made
// unknown emails twice as slow, which gave the login email away.
let equalizer: Promise<string> | null = null;

export async function verifyUserPassword(email: string, password: string): Promise<AppUser | undefined> {
	const row = stmts().byEmail.get(email.trim().toLowerCase()) as
		| { id: string; email: string; password_hash: string }
		| undefined;
	if (!row) {
		await verifyPassword(password, await (equalizer ??= hashPassword('timing-equalizer')));
		return undefined;
	}
	if (!(await verifyPassword(password, row.password_hash))) return undefined;
	return { id: row.id, email: row.email };
}

/** The password check behind a re-check, for a user with no second factor. */
export async function verifyPasswordForUser(userId: string, password: string): Promise<boolean> {
	const row = stmts().getHash.get(userId) as { password_hash: string } | undefined;
	return !!row && (await verifyPassword(password, row.password_hash));
}

export async function changePassword(userId: string, current: string, next: string): Promise<boolean> {
	if (!(await verifyPasswordForUser(userId, current))) return false;
	stmts().setPassword.run(await hashPassword(next), userId);
	return true;
}
