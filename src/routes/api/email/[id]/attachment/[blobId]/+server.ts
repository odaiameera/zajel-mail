import type { RequestHandler } from './$types';

/**
 * Stalwart sometimes returns `application/octet-stream` for blobs even when
 * the original part had a specific MIME type. The browser then refuses to
 * render the response inline (e.g. the PDF viewer iframe just downloads).
 * When the upstream type is the generic catch-all, fall back to a
 * filename-extension lookup so the inline viewer can do its job.
 */
const MIME_OVERRIDES: Record<string, string> = {
	pdf: 'application/pdf',
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	svg: 'image/svg+xml',
	bmp: 'image/bmp',
	txt: 'text/plain; charset=utf-8',
	csv: 'text/csv; charset=utf-8',
	tsv: 'text/tab-separated-values; charset=utf-8',
	json: 'application/json; charset=utf-8',
	md: 'text/markdown; charset=utf-8'
};

/**
 * Header values must be Latin-1, so a name such as "تقرير.pdf" would make the
 * Response constructor throw. Send it UTF-8 encoded in `filename*` (RFC 6266),
 * with an ASCII-only `filename` for clients that ignore that.
 */
function contentDisposition(disposition: string, filename: string): string {
	const name = filename.replace(/[\u0000-\u001f\u007f"\\]/g, '');
	const fallback = name.replace(/[^\x20-\x7e]/g, '_') || 'attachment';
	const encoded = encodeURIComponent(name).replace(
		/['()*]/g,
		(c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
	);
	return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/**
 * Proxy a JMAP blob download so the user's auth header never reaches the
 * browser. Defaults to `Content-Disposition: attachment` (safe for direct
 * hits and bookmarks); the built-in viewer opts in to inline rendering by
 * passing `?disposition=inline`.
 */
export const GET: RequestHandler = async ({ params, locals, url }) => {
	if (!locals.auth) {
		return new Response('Unauthorized', { status: 401 });
	}

	const filename = url.searchParams.get('name') ?? 'attachment';
	const disposition = url.searchParams.get('disposition') === 'inline' ? 'inline' : 'attachment';

	const downloadUrl =
		`${locals.auth.apiUrl}download/${locals.auth.accountId}/${params.blobId}/${encodeURIComponent(filename)}`;

	const res = await fetch(downloadUrl, {
		headers: { Authorization: locals.auth.authHeader }
	});

	if (!res.ok) {
		return new Response('Download failed', { status: res.status });
	}

	const upstreamType = res.headers.get('Content-Type') ?? 'application/octet-stream';
	const ext = filename.toLowerCase().split('.').pop() ?? '';
	const effectiveType =
		upstreamType.startsWith('application/octet-stream') && MIME_OVERRIDES[ext]
			? MIME_OVERRIDES[ext]
			: upstreamType;

	return new Response(res.body, {
		status: 200,
		headers: {
			'Content-Type': effectiveType,
			'Content-Disposition': contentDisposition(disposition, filename),
			'Content-Length': res.headers.get('Content-Length') ?? '',
			// Lock down inline-rendered SVGs / HTML attachments so they can't
			// run scripts or fetch tracking pixels through the viewer iframe.
			'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
			// Force the browser to trust our Content-Type rather than
			// sniffing — required for inline PDF rendering when the override
			// above kicks in.
			'X-Content-Type-Options': 'nosniff'
		}
	});
};
