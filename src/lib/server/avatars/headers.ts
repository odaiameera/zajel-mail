/**
 * Headers for every response that serves fetched or uploaded image bytes
 * from this origin: sender avatars, account avatars, proxied mail images.
 *
 * The bytes can be an attacker-controlled SVG (BIMI logos, SVG favicons, a
 * file someone uploaded), and the endpoints are same-origin and directly
 * navigable, so a plain `image/svg+xml` response would run embedded <script>
 * on a top-level navigation (stored XSS). The sandbox CSP neutralizes script
 * even then; nosniff blocks MIME confusion; the disposition keeps it an
 * image. Caching is the caller's call: sender avatars are immutable for a
 * day, an account's avatar must revalidate so a new upload shows at once.
 */
export function imageResponseHeaders(etag: string, cacheControl: string): Record<string, string> {
	return {
		'Cache-Control': cacheControl,
		ETag: etag,
		'X-Content-Type-Options': 'nosniff',
		'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
		'Content-Disposition': 'inline; filename="avatar"'
	};
}
