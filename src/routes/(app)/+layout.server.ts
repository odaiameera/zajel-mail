import { redirect } from '@sveltejs/kit';
import { assistantConfigured } from '$lib/server/ai/chat';
import type { LayoutServerLoad } from './$types';
import { createClient } from '$lib/jmap/auth';
import { getMailboxes } from '$lib/jmap/mailbox';
import { getIdentities } from '$lib/jmap/identities';
import { JMAPAuthError } from '$lib/jmap/client';
import { listAccounts, markNeedsReauth } from '$lib/server/auth/accounts';
import { unreadBadges } from '$lib/server/auth/unread-badges';
import { listLabels, migrateKeywordLabelsIfNeeded } from '$lib/server/labels';
import { syncIdentities } from '$lib/server/db/queries/identities';
import { loadRules } from '$lib/server/rules-store';
import { readPreferences } from '$lib/server/preferences';
import { getDisplayName } from '$lib/server/db/queries/app-prefs';
import { getJevSettings } from '$lib/server/db/queries/jev-settings';
import { applyInboxHold, inboxHoldOn, knownInboxId, readInboxHold } from '$lib/server/jev/hold';
import { INBOX_HOLD_MS } from '$lib/inbox-hold';
import { parseMarkReadDelay } from '$lib/mail-prefs';

export const load: LayoutServerLoad = async ({ locals, cookies }) => {
	if (!locals.user) {
		redirect(303, '/login');
	}
	if (!locals.auth) {
		// Logged into the webmail but no usable mail account: either none
		// linked yet (finish setup) or the active one needs re-auth.
		redirect(303, (locals.accounts?.length ?? 0) === 0 ? '/setup' : '/reauth');
	}

	try {
		const client = createClient(locals.auth);

		const accounts = locals.accounts ?? [];
		const activeAccount = accounts.find((a) => a.id === locals.activeAccountId);
		const userEmail = activeAccount?.email ?? '';

		// Preferences come from SQLite keyed to the webmail login, so they are
		// the same on every browser and every linked account. The first call
		// after the upgrade imports the old cookies and clears them.
		const prefs = readPreferences(locals.user.id, cookies);

		const readingPane = prefs.reading_pane ?? 'on';
		const theme = prefs.theme ?? 'dark';
		const density = prefs.density ?? 'comfortable';
		// The person's own name wins; the active account's name and finally the
		// local-part stand in for it until they set one.
		const displayName =
			getDisplayName(locals.user.id) ??
			activeAccount?.displayName ??
			userEmail.split('@')[0] ??
			'';

		// One-shot migration from keyword-based labels to JMAP mailbox labels.
		// Idempotent; the marker cookie makes subsequent loads a no-op. Must
		// finish before the label fetch below sees the mailboxes it creates.
		await migrateKeywordLabelsIfNeeded(client, locals.auth.accountId, userEmail, cookies);

		// Refresh the identity cache on every navigation. Single Identity/get
		// round-trip; the user picked "always refresh" over stale-while-
		// revalidate so the cache is never older than one page load. Failures
		// are non-fatal — a stale cache is better than a broken page.
		const identityRefresh = (async () => {
			try {
				const remote = await getIdentities(client, locals.auth!.accountId);
				const primaryByEmail = remote.find(
					(r) => r.email.toLowerCase() === userEmail.toLowerCase()
				);
				const primaryId = primaryByEmail?.id ?? remote[0]?.id;
				syncIdentities(
					userEmail,
					remote.map((r) => ({
						jmapId: r.id,
						email: r.email,
						name: r.name,
						replyTo: r.replyTo,
						isPrimary: r.id === primaryId
					}))
				);
			} catch (err) {
				console.warn('[identities] sync failed; using cached values', err);
			}
		})();

		// These hit the mail server independently — run them concurrently so
		// every navigation costs one round-trip's latency, not the sum of
		// three. This load re-runs on each invalidateAll(), so it's hot.
		// While Jev sorts the Inbox tabs, the Inbox's unread count leaves out
		// new mail it hasn't finished with, as the tabs do (see inbox-hold).
		// The hold is asked about alongside the mailboxes, using the Inbox id
		// from the last load; only the first load (or a new Inbox) waits.
		const holdAccount = inboxHoldOn(locals.activeAccountId) ? locals.activeAccountId! : null;
		const accountId = locals.auth.accountId;
		const holdInbox = holdAccount ? knownInboxId(holdAccount) : undefined;
		const [mailboxList, labels, accountUnread, earlyHold] = await Promise.all([
			getMailboxes(client, accountId),
			listLabels(client, locals.auth.accountId, userEmail),
			// Inbox unread counts for the other accounts' switcher badges.
			// Cached server-side (30s) so navigations stay cheap.
			unreadBadges(listAccounts(locals.user.id), locals.activeAccountId),
			holdInbox ? readInboxHold(client, accountId, holdInbox) : null,
			identityRefresh
		]);
		let mailboxes = mailboxList;
		let inboxHoldEndsAt: number | null = null;
		if (holdAccount) {
			const inboxId = mailboxList.find((m) => m.role === 'inbox')?.id;
			const hold = !inboxId ? null : inboxId === holdInbox ? earlyHold : await readInboxHold(client, accountId, inboxId);
			({ mailboxes, releaseAt: inboxHoldEndsAt } = applyInboxHold(holdAccount, mailboxList, hold));
		}

		// Rules live in SQLite now (device-independent). loadRules also performs
		// the one-time import from the legacy per-browser `mail_rules` cookie.
		const rules = loadRules(userEmail, cookies);

		// Sidebar expand/collapse state — Record<id, boolean>. Absence means
		// "default": section headers expanded, individual folders collapsed.
		let folderExpanded: Record<string, boolean> = {};
		const rawExpanded = prefs.folder_expanded;
		if (rawExpanded) {
			try {
				const parsed = JSON.parse(rawExpanded);
				if (parsed && typeof parsed === 'object') folderExpanded = parsed;
			} catch {
				// Ignore a malformed blob.
			}
		}

		// Notification prefs are surfaced here (not just in the settings
		// layout) so the realtime layer can decide whether to fire desktop
		// notifications for new mail without a second round-trip.
		const notificationsEnabled = prefs.notifications === 'on';
		// Calendar notification channels default to on once the master
		// toggle is enabled; users opt out per-channel.
		const notifyCalendarEvents = prefs.notify_calendar_events !== 'off';
		const notifyEventReminders = prefs.notify_event_reminders !== 'off';
		// Whether copying a detected sign-in code also moves the email to
		// Trash. On unless turned off in Settings → Messages.
		const otpTrashAfterCopy = prefs.otp_trash_after_copy !== 'off';

		return {
			mailboxes,
			// How long until the first message the Inbox is holding shows
			// anyway (ms from now), so the page refreshes for it even when Jev
			// never answers and nothing else changes; null when none is held.
			// Never more than one hold, whatever date a message carries.
			inboxHoldEndsIn:
				inboxHoldEndsAt === null ? null : Math.min(Math.max(0, inboxHoldEndsAt - Date.now()), INBOX_HOLD_MS),
			accountId: locals.auth.accountId,
			userEmail,
			accounts,
			activeAccountId: locals.activeAccountId,
			activeAccountColor: activeAccount?.color ?? null,
			accountUnread,
			readingPaneDefault: readingPane === 'on',
			theme,
			density,
			displayName,
			labels,
			rules,
			folderExpanded,
			notificationsEnabled,
			notifyCalendarEvents,
			notifyEventReminders,
			otpTrashAfterCopy,
			// Composer defaults: the font new mail is written and sent in, and
			// how often an open draft saves itself (seconds).
			composerFont: prefs.composer_font ?? 'Calibri',
			composerFontSize: prefs.composer_font_size ?? '12',
			autoSaveInterval: Number(prefs.autosave_interval) || 10,
			// Settings → Messages → "Auto-load remote images": the reading view
			// proxies or blocks a message's remote images by it.
			autoLoadImages: prefs.auto_load_images ?? 'contacts_only',
			// Settings → Messages → "Mark as read after", in milliseconds: how
			// long an open message waits before the reading view marks it read.
			markReadDelay: parseMarkReadDelay(prefs.mark_read_delay),
			// Whether Jev reads this account's mail — the message view then
			// offers its "Why is this here?" chip.
			jevReads: activeAccount ? getJevSettings(activeAccount.id).jevEnabled : false,
			// Whether this account's Inbox is split into tabs — the message view
			// then names the tab a message is in, beside its labels. Not
			// `inboxTabs`: the Inbox page's own data has that name, for its tabs.
			inboxTabsOn: activeAccount ? getJevSettings(activeAccount.id).inboxTabs : false,
			// "Create event from email" (LLM extraction) only renders when an
			// Ollama endpoint is configured server-side.
			aiEnabled: assistantConfigured()
		};
	} catch (err) {
		if (err instanceof JMAPAuthError) {
			// The mail server rejected the stored credentials (password
			// changed). The webmail session stays valid — flag the account
			// and send the user to the reconnect page.
			if (locals.activeAccountId) markNeedsReauth(locals.activeAccountId);
			redirect(303, '/reauth');
		}
		throw err;
	}
};
