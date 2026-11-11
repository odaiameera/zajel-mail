import { json } from '@sveltejs/kit';
import { deleteRulesForMailbox } from '$lib/server/rules/store';
import { refreshPipeline } from '$lib/server/mail-pipeline';
import type { RequestHandler } from './$types';
import { createClient } from '$lib/jmap/auth';
import { ensureArchiveMailbox } from '$lib/jmap/mailbox';
import {
	createLabelMailbox,
	deleteLabelMailbox,
	renameLabelMailbox
} from '$lib/jmap/labels';
import { listLabels } from '$lib/server/labels';
import { deleteMailboxMeta, setMailboxMeta } from '$lib/server/db/queries/mailbox-meta';

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.auth) return json({ error: 'Not authenticated' }, { status: 401 });
	const client = createClient(locals.auth);
	const labels = await listLabels(client, locals.auth.accountId, locals.activeAccountId);
	return json({ labels });
};

/**
 * Create, rename and delete labels. Colour and icon are set through
 * PATCH /api/mailboxes/[id]/meta; a colour sent with a create is kept for
 * clients that still send one.
 */
type CreateBody = { action: 'create'; name: string; color?: string };
type RenameBody = { action: 'rename'; id: string; name: string };
type DeleteBody = { action: 'delete'; id: string };
type Body = CreateBody | RenameBody | DeleteBody;

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.auth) return json({ error: 'Not authenticated' }, { status: 401 });

	const body = (await request.json()) as Body;
	const client = createClient(locals.auth);
	const accountId = locals.auth.accountId;
	const accountRowId = locals.activeAccountId;

	switch (body.action) {
		case 'create': {
			const name = body.name?.trim();
			if (!name) return json({ error: 'Name required' }, { status: 400 });
			const result = await createLabelMailbox(client, accountId, name);
			if ('error' in result) {
				return json({ success: false, error: result.error }, { status: 400 });
			}
			if (accountRowId && typeof body.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(body.color)) {
				setMailboxMeta(accountRowId, result.id, { color: body.color });
			}

			const labels = await listLabels(client, accountId, accountRowId);
			return json({ success: true, id: result.id, labels });
		}

		case 'rename': {
			const name = body.name?.trim();
			if (!name || !body.id) return json({ error: 'id and name required' }, { status: 400 });

			const result = await renameLabelMailbox(client, accountId, body.id, name);
			if (!result.success) {
				return json({ success: false, error: result.error }, { status: 400 });
			}
			// The label's own name is its name now; an older display name would hide it.
			if (accountRowId) setMailboxMeta(accountRowId, body.id, { displayName: null });

			const labels = await listLabels(client, accountId, accountRowId);
			return json({ success: true, labels });
		}

		case 'delete': {
			if (!body.id) return json({ error: 'id required' }, { status: 400 });

			// Messages that were in nothing but this label end up in Archive.
			const result = await deleteLabelMailbox(client, accountId, body.id, () =>
				ensureArchiveMailbox(client, accountId)
			);
			if (!result.success) {
				return json({ success: false, error: result.error }, { status: 400 });
			}
			if (accountRowId) deleteMailboxMeta(accountRowId, body.id);
			// The rules that only filed into it go with it; one that also marks
			// read, stars or stops later rules stays, filing nowhere.
			const { deleted: rulesDeleted, kept: rulesKept } = locals.activeAccountId
				? deleteRulesForMailbox(locals.activeAccountId, body.id)
				: { deleted: 0, kept: 0 };
			if (rulesDeleted || rulesKept) refreshPipeline();

			const labels = await listLabels(client, accountId, accountRowId);
			return json({ success: true, labels, rulesDeleted, rulesKept });
		}

		default:
			return json({ error: 'Unknown action' }, { status: 400 });
	}
};
