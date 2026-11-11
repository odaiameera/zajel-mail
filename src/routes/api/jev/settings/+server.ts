import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listAccounts } from '$lib/server/auth/accounts';
import { isSpamMode, updateJevSettings, type JevSettings } from '$lib/server/db/queries/jev-settings';
import { jevMode } from '$lib/server/jev/client';
import { refreshJevWatchers } from '$lib/server/jev/stream';

/** Change one linked account's Jev settings: `inboxTabs`, `jevEnabled` and/or `spamMode`. */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) error(401, 'Not signed in');

	let body: { accountId?: unknown; inboxTabs?: unknown; jevEnabled?: unknown; spamMode?: unknown };
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid JSON body' }, { status: 400 });
	}

	// The account must be one of this login's own linked mailboxes.
	const accountId = typeof body.accountId === 'string' ? body.accountId : '';
	if (!listAccounts(locals.user.id).some((a) => a.id === accountId)) {
		return json({ error: 'Unknown account' }, { status: 404 });
	}

	const patch: Partial<JevSettings> = {};
	for (const key of ['inboxTabs', 'jevEnabled'] as const) {
		if (body[key] === undefined) continue;
		if (typeof body[key] !== 'boolean') {
			return json({ error: `${key} must be true or false` }, { status: 400 });
		}
		patch[key] = body[key];
	}
	if (body.spamMode !== undefined) {
		if (!isSpamMode(body.spamMode)) return json({ error: 'spamMode must be off, watch or active' }, { status: 400 });
		patch.spamMode = body.spamMode;
	}
	if (Object.keys(patch).length === 0) {
		return json({ error: 'Nothing to change' }, { status: 400 });
	}
	// Switching Jev on is consent to send this account's new mail to
	// TypeSafe, which only means something once a key is configured.
	if ((patch.jevEnabled === true || (patch.spamMode && patch.spamMode !== 'off')) && jevMode() === 'off') {
		return json({ error: 'Jev isn’t configured on this server' }, { status: 409 });
	}

	const settings = updateJevSettings(accountId, patch);
	// Tabs or Jev going on or off changes whether this account's new mail is
	// sorted (and held for it): its push stream follows now, not a minute on.
	refreshJevWatchers();
	return json({
		success: true,
		settings: { inboxTabs: settings.inboxTabs, jevEnabled: settings.jevEnabled, spamMode: settings.spamMode }
	});
};
