/**
 * Every preference stored in `app_prefs.prefs`, keyed to the webmail login:
 * what Settings → Import / Export lists, the export file holds, an import
 * accepts and Reset clears. Shared so the page and the server can't disagree.
 */
export const PREFERENCES = [
	{ key: 'theme', description: 'Light or dark theme' },
	{ key: 'density', description: 'Row density' },
	{ key: 'reading_pane', description: 'Reading pane on or off' },
	{ key: 'composer_font', description: 'Composer font' },
	{ key: 'composer_font_size', description: 'Composer font size' },
	{ key: 'autosave_interval', description: 'Draft auto-save interval, seconds' },
	{ key: 'undo_send_seconds', description: 'Undo send window, seconds' },
	{ key: 'mark_read_delay', description: 'Mark as read after, milliseconds' },
	{ key: 'auto_load_images', description: 'Remote images' },
	{ key: 'default_sort', description: 'List order' },
	{ key: 'trash_retention_days', description: 'Empty Trash after, days (0 = never)' },
	{ key: 'otp_trash_after_copy', description: 'Trash sign-in code emails after copying' },
	{ key: 'notifications', description: 'Browser notifications on or off' },
	{ key: 'notification_folders', description: 'Folders that notify' },
	{ key: 'notify_calendar_events', description: 'Notify for new and changed events' },
	{ key: 'notify_event_reminders', description: 'Event reminders' },
	{ key: 'calendar_week_start', description: 'First day of the week' },
	{ key: 'calendar_view', description: 'Last calendar view' },
	{ key: 'auto_reply_enabled', description: 'Auto-reply on or off' },
	{ key: 'auto_reply_subject', description: 'Auto-reply subject' },
	{ key: 'auto_reply_body', description: 'Auto-reply message' },
	{ key: 'auto_reply_from', description: 'Auto-reply first day' },
	{ key: 'auto_reply_until', description: 'Auto-reply last day' },
	{ key: 'auto_reply_tz', description: 'Time zone of the auto-reply dates' },
	{ key: 'folder_expanded', description: 'Which sidebar folders are expanded' },
	// Written by /api/user-state/settings and read by getDefaultPageSize();
	// the one camelCase key, kept so stored rows match.
	{ key: 'defaultPageSize', description: 'Messages per page' }
] as const;

export type PrefKey = (typeof PREFERENCES)[number]['key'];
