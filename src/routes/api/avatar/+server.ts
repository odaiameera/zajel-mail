import { createHash } from 'node:crypto';
import type { RequestHandler } from './$types';
import { getAvatar, type AvatarOut } from '$lib/server/avatars';
import { imageResponseHeaders } from '$lib/server/avatars/headers';

/**
 * GET /api/avatar?email=<sender>
 *
 * Serves the cached sender/company avatar, resolving it on a cold cache.
 * Auth-gated: who emails you is private, so only a signed-in session may ask.
 * Returns 204 (not 404) when there's no avatar, so the <img> onerror handler
 * can cleanly fall back to initials without console noise.
 */

// Bound the request: resolution has tight per-source timeouts, but a cold row
// hitting BIMI + favicon + Gravatar in series could still take a few seconds.
// If it overruns, answer 204 now; the in-flight resolution keeps running and
// populates the cache for the next load.
const RESOLVE_BUDGET_MS = 5000;

// The avatar bytes can be an attacker-controlled SVG; `imageResponseHeaders`
// is what keeps that from running as a page. Normal long-lived private
// caching for the (immutable) image.
const CACHE_CONTROL = 'private, max-age=86400';

function withTimeout(p: Promise<AvatarOut>, ms: number): Promise<AvatarOut> {
	return new Promise((resolve) => {
		let settled = false;
		const timer = setTimeout(() => {
			if (!settled) {
				settled = true;
				resolve({ status: 'missing' });
			}
		}, ms);
		p.then(
			(v) => {
				if (!settled) {
					settled = true;
					clearTimeout(timer);
					resolve(v);
				}
			},
			() => {
				if (!settled) {
					settled = true;
					clearTimeout(timer);
					resolve({ status: 'missing' });
				}
			}
		);
	});
}

export const GET: RequestHandler = async ({ url, locals, request }) => {
	if (!locals.user) return new Response(null, { status: 401 });

	const email = url.searchParams.get('email');
	if (!email || !email.includes('@') || email.length > 320) {
		return new Response(null, { status: 400 });
	}

	const result = await withTimeout(getAvatar(email), RESOLVE_BUDGET_MS);

	if (result.status !== 'found') {
		// Don't cache the "no avatar" answer: the background worker may resolve
		// this sender seconds later, and an HTTP-cached 204 would keep the row
		// showing initials until the cache expired. no-store lets the next
		// visit re-check and pick up a now-warm avatar.
		return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
	}

	const etag = '"' + createHash('sha1').update(result.bytes).digest('base64') + '"';
	if (request.headers.get('if-none-match') === etag) {
		return new Response(null, { status: 304, headers: imageResponseHeaders(etag, CACHE_CONTROL) });
	}

	return new Response(new Uint8Array(result.bytes), {
		status: 200,
		headers: {
			...imageResponseHeaders(etag, CACHE_CONTROL),
			'Content-Type': result.contentType,
			'X-Avatar-Source': result.source
		}
	});
};
