import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { MAILTO_PARAM } from '$lib/utils/mailto';

/**
 * Entry point for the `mailto:` protocol handler (see manifest.webmanifest and
 * the registerProtocolHandler call in the (app) layout). When the OS / browser
 * treats this PWA as the default mail app, clicking a `mailto:` link opens
 *   /mailto?to=<url-encoded full mailto: URL>
 *
 * The link goes on to the inbox as it came, where the (app) layout reads it
 * and opens the composer with its recipients, subject and body. A link with
 * nothing in it still opens an empty message: someone asked to write one.
 */

// A redirect carries its target in a response header, and a reverse proxy
// reads only so much of a response's head (nginx: 4 KB by default) before it
// answers 502 Bad Gateway. A link with a long body goes in a page instead,
// which sends the browser on the same way.
const REDIRECT_LIMIT = 2000;

function escapeAttr(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export const GET: RequestHandler = ({ url }) => {
	const raw = url.searchParams.get('to') ?? '';
	const target = `/inbox?${MAILTO_PARAM}=${encodeURIComponent(raw)}`;
	if (target.length <= REDIRECT_LIMIT) redirect(303, target);

	const href = escapeAttr(target);
	return new Response(
		'<!doctype html><html><head><meta charset="utf-8">' +
			'<meta name="color-scheme" content="dark light">' +
			`<meta http-equiv="refresh" content="0;url=${href}"><title>Zajel Mail</title></head>` +
			`<body><a href="${href}">Continue to Zajel Mail</a></body></html>`,
		{
			headers: {
				'content-type': 'text/html; charset=utf-8',
				'cache-control': 'no-store',
				'content-security-policy': "default-src 'none'; frame-ancestors 'none'"
			}
		}
	);
};
