import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { userEmailFromAuth } from '$lib/server/user';
import { deleteSignature, updateSignature } from '$lib/server/db/queries/signatures';
import { sanitizeSignatureHtml } from '$lib/utils/sanitize-signature';

const MAX_NAME = 80;
// Markup, not text: the editor writes a font and a size on every line, so
// a signature well inside the 5,000 characters its page allows can be
// several times that long as HTML.
const MAX_HTML = 60_000;

function parseId(raw: string): number | null {
	const id = Number.parseInt(raw, 10);
	return Number.isFinite(id) && id > 0 ? id : null;
}

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	if (!locals.auth) return json({ error: 'Unauthorized' }, { status: 401 });
	const id = parseId(params.id);
	if (id === null) return json({ error: 'Bad id' }, { status: 400 });
	const email = userEmailFromAuth(locals.auth);

	const body = (await request.json().catch(() => null)) as
		| { name?: string; html?: string; isDefault?: boolean }
		| null;
	if (!body) return json({ error: 'Invalid body' }, { status: 400 });

	const patch: { name?: string; html?: string; isDefault?: boolean } = {};
	if (typeof body.name === 'string') {
		const name = body.name.trim().slice(0, MAX_NAME);
		if (name.length === 0) return json({ error: 'A signature needs a name.' }, { status: 400 });
		patch.name = name;
	}
	if (typeof body.html === 'string') {
		if (body.html.length > MAX_HTML) {
			return json({ error: 'The signature is too long.' }, { status: 413 });
		}
		patch.html = sanitizeSignatureHtml(body.html);
	}
	if (typeof body.isDefault === 'boolean') {
		patch.isDefault = body.isDefault;
	}

	const updated = updateSignature(email, id, patch);
	if (!updated) return json({ error: 'This signature no longer exists.' }, { status: 404 });
	return json(updated);
};

export const DELETE: RequestHandler = ({ locals, params }) => {
	if (!locals.auth) return json({ error: 'Unauthorized' }, { status: 401 });
	const id = parseId(params.id);
	if (id === null) return json({ error: 'Bad id' }, { status: 400 });
	const email = userEmailFromAuth(locals.auth);
	deleteSignature(email, id);
	return json({ success: true });
};
