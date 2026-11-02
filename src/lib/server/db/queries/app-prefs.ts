import { getDb } from '../index';
import { parseMailSort, type MailSort } from '$lib/mail-prefs';

/**
 * App-level identity and preferences, keyed by the webmail login
 * (`app_user.id`) rather than by a mail account.
 *
 * This is the distinction that matters: `user_settings` is keyed by the
 * ACTIVE mail account's email, which is right for per-mailbox data (labels,
 * folders, signatures) and wrong for anything belonging to the person. A
 * display name, an avatar and a theme are the person's, so they live here and
 * stay the same whichever account is in front of you.
 */

export interface AppAvatar {
	data: string;
	offset: { x: number; y: number; zoom: number };
}

const DEFAULT_OFFSET = { x: 0, y: 0, zoom: 1 };

/**
 * Lazy-prepared, for the same reason as the other query modules: preparing at
 * module scope would open the DB during `vite build`'s SSR pass, before
 * migrations have run.
 */
let _stmts: ReturnType<typeof prepareStmts> | null = null;
function prepareStmts() {
	const db = getDb();
	return {
		ensureRow: db.prepare(
			`INSERT INTO app_prefs (user_id) VALUES (?) ON CONFLICT (user_id) DO NOTHING`
		),
		getRow: db.prepare(
			`SELECT display_name AS displayName, prefs FROM app_prefs WHERE user_id = ?`
		),
		getPrefs: db.prepare(`SELECT prefs FROM app_prefs WHERE user_id = ?`),
		setPrefs: db.prepare(
			`UPDATE app_prefs SET prefs = ?, updated_at = datetime('now') WHERE user_id = ?`
		),
		setDisplayName: db.prepare(
			`UPDATE app_prefs SET display_name = ?, updated_at = datetime('now') WHERE user_id = ?`
		),
		getAvatar: db.prepare(
			`SELECT avatar_data AS data, avatar_offset AS offset FROM app_prefs WHERE user_id = ?`
		),
		setAvatar: db.prepare(
			`UPDATE app_prefs SET avatar_data = ?, avatar_offset = ?, updated_at = datetime('now')
			 WHERE user_id = ?`
		)
	};
}
function stmts() {
	return (_stmts ??= prepareStmts());
}

function parseJson(raw: string | null | undefined): Record<string, string> {
	if (!raw) return {};
	try {
		const parsed = JSON.parse(raw);
		// Guard against a non-object blob; callers index this freely.
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
		return parsed as Record<string, string>;
	} catch {
		// Corrupt JSON — start clean rather than throw. Re-saving repairs it.
		return {};
	}
}

/** Raw preference map. Values are strings, matching the cookie shape they replaced. */
export function getPrefs(userId: string): Record<string, string> {
	const s = stmts();
	s.ensureRow.run(userId);
	const row = s.getPrefs.get(userId) as { prefs: string } | undefined;
	return parseJson(row?.prefs);
}

/** Shallow-merge. A key set to `undefined` is removed. */
export function patchPrefs(userId: string, patch: Record<string, string | undefined>): void {
	const s = stmts();
	s.ensureRow.run(userId);
	const row = s.getPrefs.get(userId) as { prefs: string } | undefined;
	const merged = { ...parseJson(row?.prefs) };
	for (const [key, value] of Object.entries(patch)) {
		if (value === undefined) delete merged[key];
		else merged[key] = value;
	}
	s.setPrefs.run(JSON.stringify(merged), userId);
}

/** Drop every stored preference, leaving identity (name, avatar) intact. */
export function clearPrefs(userId: string): void {
	const s = stmts();
	s.ensureRow.run(userId);
	s.setPrefs.run('{}', userId);
}

export function getDisplayName(userId: string): string | null {
	const s = stmts();
	s.ensureRow.run(userId);
	const row = s.getRow.get(userId) as { displayName: string | null } | undefined;
	return row?.displayName ?? null;
}

export function setDisplayName(userId: string, displayName: string): void {
	const s = stmts();
	s.ensureRow.run(userId);
	s.setDisplayName.run(displayName, userId);
}

export function getAvatar(userId: string): AppAvatar | null {
	const s = stmts();
	s.ensureRow.run(userId);
	const row = s.getAvatar.get(userId) as
		| { data: string | null; offset: string | null }
		| undefined;
	if (!row?.data) return null;

	let offset = { ...DEFAULT_OFFSET };
	if (row.offset) {
		try {
			const parsed = JSON.parse(row.offset);
			if (parsed && typeof parsed === 'object') {
				offset = {
					x: typeof parsed.x === 'number' ? parsed.x : 0,
					y: typeof parsed.y === 'number' ? parsed.y : 0,
					zoom: typeof parsed.zoom === 'number' ? parsed.zoom : 1
				};
			}
		} catch {
			// keep defaults
		}
	}
	return { data: row.data, offset };
}

export function setAvatar(
	userId: string,
	data: string,
	offset: { x: number; y: number; zoom: number }
): void {
	const s = stmts();
	s.ensureRow.run(userId);
	s.setAvatar.run(data, JSON.stringify(offset), userId);
}

export function clearAvatar(userId: string): void {
	const s = stmts();
	s.ensureRow.run(userId);
	s.setAvatar.run(null, null, userId);
}

const ALLOWED_PAGE_SIZES = [10, 25, 50, 100] as const;

/** Settings → Messages → Default sort, for the Inbox, folder and Starred lists. */
export function getDefaultSort(userId: string): MailSort {
	return parseMailSort(getPrefs(userId).default_sort);
}

/** Rows per page in the mail list. Stored as a string, like every preference. */
export function getDefaultPageSize(userId: string): number {
	const raw = getPrefs(userId).defaultPageSize;
	const n = parseInt(String(raw), 10);
	return (ALLOWED_PAGE_SIZES as readonly number[]).includes(n) ? n : 50;
}
