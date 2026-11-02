import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createClient } from '$lib/jmap/auth';
import { EmailUpdateError } from '$lib/jmap/email';
import { applyLabel, removeLabel } from '$lib/jmap/labels';
import { ensureArchiveMailbox, getMailboxes } from '$lib/jmap/mailbox';
import { labelMailboxIds } from '$lib/types/labels';

/**
 * Add a label to a message or take one off. `labelId` is a JMAP Mailbox id
 * and has to be one of the account's labels: the same call with a folder id
 * would file the message there (Trash included, which the retention sweep
 * then empties). A message that was in nothing but the label goes to
 * Archive when the label comes off, since it has to be somewhere.
 */
export const POST: RequestHandler = async ({ request, locals, params }) => {
	if (!locals.auth) {
		return json({ error: 'Not authenticated' }, { status: 401 });
	}

	const body = (await request.json().catch(() => null)) as {
		labelId?: string;
		action?: 'apply' | 'remove';
	} | null;
	const labelId = body?.labelId;
	const action = body?.action;
	if (!labelId || (action !== 'apply' && action !== 'remove')) {
		return json({ error: 'labelId and valid action required' }, { status: 400 });
	}

	const client = createClient(locals.auth);
	const { accountId } = locals.auth;
	try {
		if (!labelMailboxIds(await getMailboxes(client, accountId)).has(labelId)) {
			return json({ error: 'Not a label' }, { status: 400 });
		}
		if (action === 'apply') {
			await applyLabel(client, accountId, params.id, labelId);
		} else {
			await removeLabel(client, accountId, params.id, labelId, () => ensureArchiveMailbox(client, accountId));
		}
		return json({ success: true });
	} catch (err) {
		if (err instanceof EmailUpdateError) {
			const gone = err.failures.every((f) => f.type === 'notFound');
			return json({ error: gone ? 'Email not found' : err.message }, { status: gone ? 404 : 400 });
		}
		return json({ error: err instanceof Error ? err.message : 'Failed to update label' }, { status: 502 });
	}
};
