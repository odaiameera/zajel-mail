import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createClient } from '$lib/jmap/auth';
import { getMailboxes } from '$lib/jmap/mailbox';
import { mailboxKind } from '$lib/mailboxes';
import { setMailboxMeta, type MailboxMetaPatch } from '$lib/server/db/queries/mailbox-meta';
import { NO_ICON, parseIconPatch } from '$lib/server/lucide-icons';
import { mailboxMetaView } from '$lib/server/mailbox-meta';

const MAX_NAME = 100;

/**
 * Set a folder's or label's colour, icon or display name, for the active
 * mail account: `{ color?, icon?, displayName? }`. A value left out stays
 * as it is; null clears it. Returns what is stored now (null when nothing
 * is). The mailbox has to be one of the account's own folders or labels.
 */
export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	if (!locals.auth || !locals.activeAccountId) return json({ error: 'Not authenticated' }, { status: 401 });

	const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
	if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'Invalid body' }, { status: 400 });

	const patch: MailboxMetaPatch = {};
	if (body.color !== undefined) {
		if (body.color !== null && (typeof body.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(body.color))) {
			return json({ error: 'A colour is a hex value like #0969da, or null for none' }, { status: 400 });
		}
		patch.color = body.color;
	}
	const icon = parseIconPatch(body.icon);
	if (icon === 'invalid') return json({ error: 'Unknown icon' }, { status: 400 });
	if (icon !== undefined) patch.icon = icon === NO_ICON ? null : icon;
	if (body.displayName !== undefined) {
		if (body.displayName !== null && typeof body.displayName !== 'string') {
			return json({ error: 'A display name is text, or null for none' }, { status: 400 });
		}
		const name = typeof body.displayName === 'string' ? body.displayName.trim() : '';
		if (name.length > MAX_NAME) return json({ error: `Keep the name to ${MAX_NAME} characters or fewer` }, { status: 400 });
		patch.displayName = name || null;
	}

	const client = createClient(locals.auth);
	const mailboxes = await getMailboxes(client, locals.auth.accountId);
	const mailbox = mailboxes.find((m) => m.id === params.id);
	if (!mailbox) return json({ error: 'Folder not found' }, { status: 404 });
	const kind = mailboxKind(mailbox, mailboxes);
	if (kind !== 'folder' && kind !== 'label') {
		return json({ error: 'Only folders and labels have a colour and icon' }, { status: 400 });
	}

	const saved = setMailboxMeta(locals.activeAccountId, params.id, patch);
	return json(saved && { mailboxId: saved.mailboxId, ...mailboxMetaView(saved) });
};
