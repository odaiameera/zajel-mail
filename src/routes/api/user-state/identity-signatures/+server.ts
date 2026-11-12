import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { userEmailFromAuth } from '$lib/server/user';
import {
	listIdentitySignatures,
	setIdentitySignature,
	clearIdentitySignature
} from '$lib/server/db/queries/identity-signatures';
import { listSignatures } from '$lib/server/db/queries/signatures';

export const GET: RequestHandler = ({ locals }) => {
	if (!locals.auth) return json({ error: 'Unauthorized' }, { status: 401 });
	const email = userEmailFromAuth(locals.auth);
	return json(listIdentitySignatures(email));
};

export const PUT: RequestHandler = async ({ locals, request }) => {
	if (!locals.auth) return json({ error: 'Unauthorized' }, { status: 401 });
	const email = userEmailFromAuth(locals.auth);

	const body = (await request.json().catch(() => null)) as
		| { identityId?: string; signatureId?: number }
		| null;
	if (!body || typeof body.identityId !== 'string' || typeof body.signatureId !== 'number') {
		return json({ error: 'identityId and signatureId required' }, { status: 400 });
	}

	// Only one of this login's own signatures, and one that is still there
	// (it may have been deleted while the choice waited for Save).
	if (!listSignatures(email).some((sig) => sig.id === body.signatureId)) {
		return json({ error: 'That signature no longer exists.' }, { status: 400 });
	}

	setIdentitySignature(email, body.identityId, body.signatureId);
	return json({ success: true });
};

export const DELETE: RequestHandler = ({ locals, url }) => {
	if (!locals.auth) return json({ error: 'Unauthorized' }, { status: 401 });
	const identityId = url.searchParams.get('identityId');
	if (!identityId) return json({ error: 'identityId required' }, { status: 400 });
	const email = userEmailFromAuth(locals.auth);
	clearIdentitySignature(email, identityId);
	return json({ success: true });
};
