import { getDb } from '../index';
import { dropQueue } from './jev-decisions';

/**
 * Per-account Jev settings. See migrations 011_jev.sql and
 * 012_jev_sorting.sql for why they key on the linked account rather than
 * the login.
 */

/**
 * Jev as the spam layer: off; watch — verdicts recorded and shown beside
 * Stalwart's, nothing moves; active — confident verdicts move mail.
 */
export type SpamMode = 'off' | 'watch' | 'active';

export const SPAM_MODES: SpamMode[] = ['off', 'watch', 'active'];

export function isSpamMode(value: unknown): value is SpamMode {
	return typeof value === 'string' && (SPAM_MODES as string[]).includes(value);
}

export interface JevSettings {
	/** Split the Inbox into Important / Updates / Newsletters / Promotions. */
	inboxTabs: boolean;
	/**
	 * Let Jev read this account's new mail — to sort it into tabs (with
	 * `inboxTabs`), and for spam checks and urgent alerts.
	 */
	jevEnabled: boolean;
	/**
	 * When Jev was switched on (ISO): new mail received before it is never
	 * sent to Jev. Switching Jev off clears it, and switching it on sets it
	 * to that moment. The new-mail pass clears it too while Jev can't be
	 * asked (switched on but not configured on the server), and sets it to
	 * the moment it finds Jev can be asked again (see mail-pipeline/pass.ts).
	 */
	jevSince: string | null;
	/** Jev as the spam layer; only acted on while `jevEnabled`. */
	spamMode: SpamMode;
}

export const DEFAULT_JEV_SETTINGS: JevSettings = {
	inboxTabs: false,
	jevEnabled: false,
	jevSince: null,
	spamMode: 'off'
};

let _stmts: ReturnType<typeof prepareStmts> | null = null;

/**
 * Prepared lazily for the same reason as the other query modules here:
 * preparing at module scope would open the database during `vite build`'s
 * SSR pass, before migrations have run.
 */
function prepareStmts() {
	const db = getDb();
	return {
		get: db.prepare(
			'SELECT inbox_tabs, jev_enabled, jev_since, spam_mode FROM jev_settings WHERE account_id = ?'
		),
		upsert: db.prepare(
			`INSERT INTO jev_settings (account_id, inbox_tabs, jev_enabled, jev_since, spam_mode, updated_at)
			 VALUES (@accountId, @inboxTabs, @jevEnabled, @jevSince, @spamMode, @now)
			 ON CONFLICT (account_id) DO UPDATE SET
			   inbox_tabs = excluded.inbox_tabs,
			   jev_enabled = excluded.jev_enabled,
			   jev_since = excluded.jev_since,
			   spam_mode = excluded.spam_mode,
			   updated_at = excluded.updated_at`
		),
		swapSince: db.prepare(
			`UPDATE jev_settings SET jev_since = ?, updated_at = ?
			 WHERE account_id = ? AND jev_since IS ?`
		)
	};
}
function stmts() {
	return (_stmts ??= prepareStmts());
}

export function getJevSettings(accountId: string): JevSettings {
	const row = stmts().get.get(accountId) as
		| { inbox_tabs: number; jev_enabled: number; jev_since: string | null; spam_mode: string }
		| undefined;
	if (!row) return { ...DEFAULT_JEV_SETTINGS };
	return {
		inboxTabs: row.inbox_tabs === 1,
		jevEnabled: row.jev_enabled === 1,
		jevSince: row.jev_since,
		spamMode: isSpamMode(row.spam_mode) ? row.spam_mode : 'off'
	};
}

/**
 * Merge `patch` into the account's settings and persist the result.
 * Switching Jev on sets `jevSince` to `now`, so Jev only ever sees mail
 * that arrives from then on; switching it off clears it. Either switch
 * also withdraws whatever was still queued.
 */
export function updateJevSettings(
	accountId: string,
	patch: Partial<JevSettings>,
	now = new Date()
): JevSettings {
	const current = getJevSettings(accountId);
	const next = { ...current, ...patch };
	if (patch.jevEnabled === true && !current.jevEnabled) next.jevSince = now.toISOString();
	if (patch.jevEnabled === false) next.jevSince = null;
	getDb().transaction(() => {
		stmts().upsert.run({
			accountId,
			inboxTabs: next.inboxTabs ? 1 : 0,
			jevEnabled: next.jevEnabled ? 1 : 0,
			jevSince: next.jevSince,
			spamMode: next.spamMode,
			now: now.getTime()
		});
		if (next.jevEnabled !== current.jevEnabled) dropQueue(accountId, now.getTime());
	})();
	return next;
}

/**
 * Set `jevSince` from `from` to `to`, only if it is still `from`: a switch
 * made meanwhile in Settings has already set it, and wins. Returns whether
 * it was changed.
 */
export function swapJevSince(accountId: string, from: string | null, to: string | null, now = new Date()): boolean {
	return stmts().swapSince.run(to, now.getTime(), accountId, from).changes > 0;
}

