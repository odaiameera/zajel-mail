import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { userEmailFromAuth } from '$lib/server/user';
import { createSignature, listSignatures } from '$lib/server/db/queries/signatures';
import { sanitizeSignatureHtml } from '$lib/utils/sanitize-signature';

const MAX_NAME = 80;
// Markup, not text: the editor writes a font and a size on every line, so
// a signature well inside the 5,000 characters its page allows can be
// several times that long as HTML.
const MAX_HTML = 60_000;

export const GET: RequestHandler = ({ locals }) => {
	if (!locals.auth) return json({ error: 'Unauthorized' }, { status: 401 });
	const email = userEmailFromAuth(locals.auth);
	return json(listSignatures(email));
};

export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.auth) return json({ error: 'Unauthorized' }, { status: 401 });
	const email = userEmailFromAuth(locals.auth);

	const body = (await request.json().catch(() => null)) as
		| { name?: string; html?: string; isDefault?: boolean }
		| null;
	if (!body || typeof body.name !== 'string' || typeof body.html !== 'string') {
		return json({ error: 'name and html required' }, { status: 400 });
	}
	if (body.html.length > MAX_HTML) {
		return json({ error: 'The signature is too long.' }, { status: 413 });
	}

	const name = body.name.trim().slice(0, MAX_NAME);
	if (name.length === 0) return json({ error: 'A signature needs a name.' }, { status: 400 });

	const cleanHtml = sanitizeSignatureHtml(body.html);
	const created = createSignature(email, name, cleanHtml, body.isDefault === true);
	return json(created, { status: 201 });
};
