import { error } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';
import { readPreferences } from '$lib/server/preferences';
import { getDisplayName } from '$lib/server/db/queries/app-prefs';
import { parseTrashRetentionDays } from '$lib/constants/trash-retention';
import { parseUndoSendSeconds } from '$lib/server/compose-input';
import { parseMailSort, parseMarkReadDelay } from '$lib/mail-prefs';

function num(value: string | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	const n = parseInt(value, 10);
	return Number.isFinite(n) ? n : fallback;
}

/**
 * Load every preference the settings pages care about. These live in SQLite
 * keyed to the webmail login, so they are identical on every browser and every
 * linked account. `parent()` gives us the mailboxes/labels/rules already
 * loaded by the (app) layout so child sections don't re-fetch.
 */
export const load: LayoutServerLoad = async ({ cookies, locals, parent }) => {
	const { mailboxes, labels, rules } = await parent();
	if (!locals.user) error(401, 'Not signed in');

	const prefs = readPreferences(locals.user.id, cookies);

	let notificationFolders: string[] = ['inbox'];
	try {
		const raw = prefs.notification_folders;
		if (raw) {
			const parsed = JSON.parse(raw);
			if (Array.isArray(parsed)) notificationFolders = parsed;
		}
	} catch {
		// keep default
	}

	return {
		// Account / identity
		displayName: getDisplayName(locals.user.id) ?? '',
		// Appearance
		theme: prefs.theme ?? 'dark',
		density: prefs.density ?? 'comfortable',
		readingPane: prefs.reading_pane ?? 'on',
		// Composer
		composerFont: prefs.composer_font ?? 'Calibri',
		composerFontSize: prefs.composer_font_size ?? '12',
		autoSaveInterval: num(prefs.autosave_interval, 10),
		undoSendSeconds: parseUndoSendSeconds(prefs.undo_send_seconds),
		// Mail
		markReadDelay: parseMarkReadDelay(prefs.mark_read_delay),
		autoLoadImages: prefs.auto_load_images ?? 'contacts_only',
		defaultSort: parseMailSort(prefs.default_sort),
		trashRetentionDays: parseTrashRetentionDays(prefs.trash_retention_days),
		otpTrashAfterCopy: prefs.otp_trash_after_copy !== 'off',
		// Notifications
		notificationsEnabled: prefs.notifications === 'on',
		notificationFolders,
		notifyCalendarEvents: prefs.notify_calendar_events !== 'off',
		notifyEventReminders: prefs.notify_event_reminders !== 'off',
		// Calendar
		calendarWeekStart: prefs.calendar_week_start === '0' ? 0 : prefs.calendar_week_start === '6' ? 6 : 1,
		// Auto-reply
		autoReplyEnabled: prefs.auto_reply_enabled === 'on',
		autoReplySubject: prefs.auto_reply_subject ?? '',
		autoReplyBody: prefs.auto_reply_body ?? '',
		// Piped through for section pages that need them
		mailboxes,
		labels,
		rules
	};
};
