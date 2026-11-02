import type { Cookies } from '@sveltejs/kit';
import { getPrefs, patchPrefs, clearPrefs } from './db/queries/app-prefs';
import { PREF_COOKIE_OPTIONS } from './prefs';

/**
 * Preferences, stored server-side and keyed to the webmail login.
 *
 * These used to be browser cookies, which meant they never followed anyone to
 * a second browser or device — and, because cookies ride along on every
 * request to the origin, that a long auto-reply body could quietly exceed the
 * ~4KB cookie cap and be dropped. They now live in `app_prefs.prefs`.
 *
 * Migration follows the shape `rules-store.ts` already established for mail
 * rules: read from SQLite, and if there is nothing stored yet but the legacy
 * cookies are present, import them once and delete them. No flag day, and
 * nobody re-enters settings they had already chosen.
 */

/** Every preference key that now lives in SQLite. */
export const PREF_KEYS = [
	'display_name',
	'theme',
	'density',
	'reading_pane',
	'composer_font',
	'composer_font_size',
	'autosave_interval',
	'undo_send_seconds',
	'conversation_view',
	'mark_read_delay',
	'auto_load_images',
	'default_sort',
	'trash_retention_days',
	'otp_trash_after_copy',
	'keyboard_shortcuts',
	'notifications',
	'notification_folders',
	'notify_calendar_events',
	'notify_event_reminders',
	'calendar_week_start',
	'calendar_view',
	'auto_reply_enabled',
	'auto_reply_subject',
	'auto_reply_body',
	'folder_expanded',
	// Rows per page, written by /api/user-state/settings and read by
	// getDefaultPageSize(); the one camelCase key, kept so stored rows match.
	'defaultPageSize'
] as const;

export type PrefKey = (typeof PREF_KEYS)[number];

/**
 * Keys whose legacy cookie held a URL-encoded value (`setPrefEncoded` /
 * `setPrefJson`). Encoding was a cookie transport detail — SQLite stores the
 * raw string, so these are decoded exactly once, on import.
 */
const LEGACY_ENCODED: ReadonlySet<string> = new Set([
	'notification_folders',
	'auto_reply_subject',
	'auto_reply_body',
	'folder_expanded'
]);

/**
 * The one preference that also stays a cookie. `app.html` runs an inline
 * script before the page paints and adds `html.light` from it, which is what
 * stops a flash of the dark theme on a light-theme load. The cookie is a
 * render hint only — SQLite remains the source of truth and
 * {@link readPreferences} rewrites the cookie whenever the two disagree.
 */
export const RENDER_HINT_COOKIE = 'theme';

function importLegacyCookies(cookies: Cookies): Record<string, string> {
	const imported: Record<string, string> = {};
	for (const key of PREF_KEYS) {
		const raw = cookies.get(key);
		if (raw === undefined) continue;
		if (LEGACY_ENCODED.has(key)) {
			try {
				imported[key] = decodeURIComponent(raw);
			} catch {
				// Malformed percent-encoding — keep the raw value rather than drop
				// the setting entirely.
				imported[key] = raw;
			}
		} else {
			imported[key] = raw;
		}
	}
	return imported;
}

/**
 * Read this user's preferences, importing the legacy cookies on first call.
 *
 * Values are strings, deliberately: they are what the cookies held, so every
 * caller's existing `?? 'dark'` / `=== 'on'` / `parseInt` handling keeps
 * working unchanged.
 */
export function readPreferences(userId: string, cookies: Cookies): Record<string, string> {
	let prefs = getPrefs(userId);

	if (Object.keys(prefs).length === 0) {
		const legacy = importLegacyCookies(cookies);
		if (Object.keys(legacy).length > 0) {
			patchPrefs(userId, legacy);
			prefs = legacy;
		}
	}

	// Retire every migrated cookie, including on later loads — a second browser
	// may still be carrying its own copy, and leaving them set would let a stale
	// per-browser value shadow the stored one on the next import check.
	for (const key of PREF_KEYS) {
		if (key === RENDER_HINT_COOKIE) continue;
		if (cookies.get(key) !== undefined) cookies.delete(key, { path: '/' });
	}

	// Keep the pre-paint theme hint honest on whatever browser this is.
	const theme = prefs[RENDER_HINT_COOKIE];
	if (theme && cookies.get(RENDER_HINT_COOKIE) !== theme) {
		cookies.set(RENDER_HINT_COOKIE, theme, PREF_COOKIE_OPTIONS);
	}

	return prefs;
}

/** Persist a preference patch. Pass `cookies` so the theme hint tracks it. */
export function writePreferences(
	userId: string,
	patch: Record<string, string | undefined>,
	cookies?: Cookies
): void {
	patchPrefs(userId, patch);
	const theme = patch[RENDER_HINT_COOKIE];
	if (cookies && typeof theme === 'string') {
		cookies.set(RENDER_HINT_COOKIE, theme, PREF_COOKIE_OPTIONS);
	}
}

/** Reset to defaults: drop the stored map and the theme hint with it. */
export function resetPreferences(userId: string, cookies: Cookies): void {
	clearPrefs(userId);
	for (const key of PREF_KEYS) cookies.delete(key, { path: '/' });
}

/** Flat snapshot for the settings export endpoint. */
export function exportPreferences(userId: string): Record<string, string> {
	return getPrefs(userId);
}

/** Restore an exported snapshot, ignoring keys this app doesn't recognise. */
export function importPreferences(
	userId: string,
	incoming: Record<string, unknown>,
	cookies?: Cookies
): void {
	const known = new Set<string>(PREF_KEYS);
	const patch: Record<string, string> = {};
	for (const [key, value] of Object.entries(incoming)) {
		if (known.has(key) && typeof value === 'string') patch[key] = value;
	}
	if (Object.keys(patch).length > 0) writePreferences(userId, patch, cookies);
}
