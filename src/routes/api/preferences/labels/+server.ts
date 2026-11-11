import { json } from '@sveltejs/kit';
import { deleteRulesForMailbox } from '$lib/server/rules/store';
import type { RequestHandler } from './$types';
import { createClient } from '$lib/jmap/auth';
import { ensureArchiveMailbox } from '$lib/jmap/mailbox';
import {
	createLabelMailbox,
	deleteLabelMailbox,
	renameLabelMailbox
} from '$lib/jmap/labels';
import {
	getLabelMeta,
	listLabels,
	removeLabelMeta,
	updateLabelMeta
} from '$lib/server/labels';
import { userEmailFromAuth } from '$lib/server/user';
import { DEFAULT_LABEL_COLOR } from '$lib/types/labels';

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.auth) return json({ error: 'Not authenticated' }, { status: 401 });
	const email = userEmailFromAuth(locals.auth);
	const client = createClient(locals.auth);
	const labels = await listLabels(client, locals.auth.accountId, email);
	return json({ labels });
};

type CreateBody = { action: 'create'; name: string; color?: string };
type RenameBody = { action: 'rename'; id: string; name: string };
type DeleteBody = { action: 'delete'; id: string };
type UpdateColorBody = { action: 'updateColor'; id: string; color: string };
type Body = CreateBody | RenameBody | DeleteBody | UpdateColorBody;

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.auth) return json({ error: 'Not authenticated' }, { status: 401 });

	const email = userEmailFromAuth(locals.auth);
	const body = (await request.json()) as Body;
	const client = createClient(locals.auth);
	const accountId = locals.auth.accountId;

	switch (body.action) {
		case 'create': {
			const name = body.name?.trim();
			if (!name) return json({ error: 'Name required' }, { status: 400 });
			const color = body.color || DEFAULT_LABEL_COLOR;

			// If a mailbox with the same slug already exists, reuse its id so
			// the create is effectively idempotent from the user's POV.
			const existing = getLabelMeta(email);
			const result = await createLabelMailbox(client, accountId, name);
			if ('error' in result) {
				return json({ success: false, error: result.error }, { status: 400 });
			}

			updateLabelMeta(email, result.id, {
				color,
				displayName: name,
				createdAt: existing[result.id]?.createdAt ?? Date.now()
			});

			const labels = await listLabels(client, accountId, email);
			return json({ success: true, id: result.id, labels });
		}

		case 'rename': {
			const name = body.name?.trim();
			if (!name || !body.id) return json({ error: 'id and name required' }, { status: 400 });

			const result = await renameLabelMailbox(client, accountId, body.id, name);
			if (!result.success) {
				return json({ success: false, error: result.error }, { status: 400 });
			}
			updateLabelMeta(email, body.id, { displayName: name });

			const labels = await listLabels(client, accountId, email);
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
			removeLabelMeta(email, body.id);
			// The rules that only filed into it go with it; one that also marks
			// read, stars or stops later rules stays, filing nowhere.
			const { deleted: rulesDeleted, kept: rulesKept } = locals.activeAccountId
				? deleteRulesForMailbox(locals.activeAccountId, body.id)
				: { deleted: 0, kept: 0 };

			const labels = await listLabels(client, accountId, email);
			return json({ success: true, labels, rulesDeleted, rulesKept });
		}

		case 'updateColor': {
			if (!body.id || !body.color) return json({ error: 'id and color required' }, { status: 400 });
			updateLabelMeta(email, body.id, { color: body.color });

			const labels = await listLabels(client, accountId, email);
			return json({ success: true, labels });
		}

		default:
			return json({ error: 'Unknown action' }, { status: 400 });
	}
};
