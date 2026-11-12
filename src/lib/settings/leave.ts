import { openSaveHost } from './draft.svelte';

export const LEAVE_PROMPT = 'You have unsaved changes. Leave without saving?';

/**
 * Asks before something outside a settings page takes the person away
 * from it, for the things that change something first (switching the
 * account, starting a new event) and only then navigate: by the time the
 * settings layout's own guard asks, the change has already happened, and
 * answering "stay" would leave the page's unsaved values sitting under the
 * wrong account.
 *
 * True at once when no settings page is open or nothing on it is changed.
 * With a save under way, waits for it: true once it stored everything,
 * false when it failed (the bar shows why). Otherwise asks; on yes it
 * discards the changes (taking back any preview, as the theme), so the
 * navigation that follows doesn't ask again, and returns true; on no,
 * false, and the caller does nothing.
 */
export async function canLeaveSettings(): Promise<boolean> {
	const host = openSaveHost();
	if (!host) return true;
	if (host.saving && !(await host.settled())) return false;
	if (!host.dirty) return true;
	if (!confirm(LEAVE_PROMPT)) return false;
	host.discardAll();
	return true;
}
