import { error, json } from '@sveltejs/kit';
import { createHash } from 'node:crypto';
import type { RequestHandler } from './$types';
import {
	getAccount,
	getAccountAvatar,
	setAccountAvatar,
	clearAccountAvatar
} from '$lib/server/auth/accounts';
import { getAvatar as resolveAvatarForEmail } from '$lib/server/avatars/index';
import { imageResponseHeaders } from '$lib/server/avatars/headers';

/** Matches the personal avatar's cap; the client compresses to ~25KB anyway. */
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

const DATA_URL = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i;

// `private`: this is behind a session and must never be shared by a proxy.
// `must-revalidate` with an ETag keeps a renamed or replaced avatar from
// sticking around in the browser cache.
const CACHE_CONTROL = 'private, max-age=0, must-revalidate';

function decodeDataUrl(dataUrl: string): { contentType: string; bytes: Buffer } | null {
	const m = DATA_URL.exec(dataUrl);
	if (!m) return null;
	try {
		return { contentType: m[1], bytes: Buffer.from(m[2], 'base64') };
	} catch {
		return null;
	}
}

function etagFor(input: Buffer | string): string {
	return `"${createHash('sha1').update(input).digest('base64url').slice(0, 22)}"`;
}

/**
 * An account's avatar.
 *
 * Two sources, in order: whatever the user uploaded, then the resolver the app
 * already uses for message senders (BIMI → favicon → Gravatar). The fallback
 * is the point — for most addresses it produces the right face with no upload
 * and nothing stored, which is exactly what "same avatar wherever I sign in"
 * already means for a Gravatar-backed address. A 404 tells the client to draw
 * initials, which is what it does for senders today.
 *
 * Served as bytes rather than inlined into the account list on purpose: that
 * list is embedded in every page's server payload, so an inline data URL would
 * be re-sent on every navigation. Here the browser caches it and revalidates
 * against the ETag, so a change shows up immediately and an unchanged avatar
 * costs a 304.
 *
 * Either source can hand us an SVG — a BIMI logo, a favicon, an upload — and
 * this URL is same-origin and navigable, so the bytes go out with the same
 * sandbox headers as /api/avatar; see `imageResponseHeaders`.
 */
export const GET: RequestHandler = async ({ params, locals, request }) => {
	if (!locals.user) error(401, 'Not signed in');
	const account = getAccount(params.id);
	if (!account || account.user_id !== locals.user.id) error(404, 'Unknown account');

	let contentType: string;
	let bytes: Buffer;
	let source: string;

	const custom = getAccountAvatar(params.id);
	const decoded = custom ? decodeDataUrl(custom) : null;

	if (decoded) {
		({ contentType, bytes } = decoded);
		source = 'custom';
	} else {
		const resolved = await resolveAvatarForEmail(account.email);
		if (resolved.status !== 'found') {
			// No avatar anywhere — the client falls back to initials.
			return new Response(null, { status: 404 });
		}
		({ contentType, bytes } = resolved);
		source = resolved.source;
	}

	const etag = etagFor(bytes);
	if (request.headers.get('if-none-match') === etag) {
		return new Response(null, { status: 304, headers: imageResponseHeaders(etag, CACHE_CONTROL) });
	}

	return new Response(new Uint8Array(bytes), {
		headers: {
			...imageResponseHeaders(etag, CACHE_CONTROL),
			'Content-Type': contentType,
			'Content-Length': String(bytes.length),
			'X-Avatar-Source': source
		}
	});
};

export const PUT: RequestHandler = async ({ params, locals, request }) => {
	if (!locals.user) error(401, 'Not signed in');
	const account = getAccount(params.id);
	if (!account || account.user_id !== locals.user.id) error(404, 'Unknown account');

	const body = (await request.json().catch(() => null)) as { data?: string } | null;
	if (!body || typeof body.data !== 'string') {
		return json({ error: 'Avatar data must be a data: image URL' }, { status: 400 });
	}
	if (body.data.length > MAX_AVATAR_BYTES) {
		return json({ error: 'Avatar exceeds 2MB' }, { status: 413 });
	}
	if (!decodeDataUrl(body.data)) {
		return json({ error: 'Avatar data must be a base64 data: image URL' }, { status: 400 });
	}

	setAccountAvatar(locals.user.id, params.id, body.data);
	return json({ success: true });
};

/** Remove the upload; the resolver fallback takes over again. */
export const DELETE: RequestHandler = ({ params, locals }) => {
	if (!locals.user) error(401, 'Not signed in');
	const account = getAccount(params.id);
	if (!account || account.user_id !== locals.user.id) error(404, 'Unknown account');

	clearAccountAvatar(locals.user.id, params.id);
	return json({ success: true });
};
