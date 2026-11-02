import type { RequestHandler } from './$types';
import type { AuthState } from '$lib/jmap/types';
import { createClient } from '$lib/jmap/auth';

/**
 * Stalwart sometimes returns `application/octet-stream` for blobs even when
 * the original part had a specific MIME type. The browser then refuses to
 * render the response inline (e.g. the PDF viewer iframe just downloads).
 * The part's own type, looked up from the message, is used first; when the
 * part declares nothing better either, the filename's extension stands in so
 * the inline viewer can do its job.
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
 * Types a browser would run or navigate as a document if it rendered them
 * inline from this origin. The CSP below already sandboxes them, but a
 * download is the one outcome with nothing to get wrong, and the built-in
 * viewer reads such files as text through fetch(), which this does not affect.
 */
const SERVED_AS_DOWNLOAD =
	/^(?:text\/html|application\/xhtml\+xml|text\/xml|application\/xml|application\/(?:x-)?javascript|text\/javascript|application\/ecmascript|text\/ecmascript)\b/i;

/** A type/subtype as a JMAP part declares it (no parameters), and nothing that could reach the header line. */
const MIME_TOKEN = /^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/;

/**
 * A JMAP id is 1–255 characters of the URL-safe base64 alphabet (RFC 8620
 * §1.2). SvelteKit decodes `%2F` in the param, so without this check a link
 * could walk the download URL out of /download to any path on Stalwart,
 * fetched with the user's credentials.
 */
const JMAP_ID = /^[A-Za-z0-9_-]{1,255}$/;

/**
 * Header values must be Latin-1, so a name such as "تقرير.pdf" would make the
 * Response constructor throw. Send it UTF-8 encoded in `filename*` (RFC 6266),
 * with an ASCII-only `filename` for clients that ignore that.
 */
function contentDisposition(disposition: string, filename: string): string {
	// eslint-disable-next-line no-control-regex -- control characters are exactly what it strips
	const name = filename.replace(/[\u0000-\u001f\u007f"\\]/g, '');
	const fallback = name.replace(/[^\x20-\x7e]/g, '_') || 'attachment';
	const encoded = encodeURIComponent(name).replace(
		/['()*]/g,
		(c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
	);
	return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

type BodyPartLike = { blobId?: string; type?: string };
type PartLists = Partial<Record<'attachments' | 'htmlBody' | 'textBody', BodyPartLike[]>>;

/**
 * The declared MIME type of each of a message's parts, by blob id — one
 * Email/get without body values. Kept for a minute per message so a body full
 * of inline images costs one lookup, not one per image.
 */
const PART_TYPES_TTL_MS = 60_000;
const PART_TYPES_MAX = 256;
const partTypesCache = new Map<string, { at: number; types: Promise<Map<string, string>> }>();

async function fetchPartTypes(auth: AuthState, emailId: string): Promise<Map<string, string>> {
	const response = await createClient(auth).request([
		['Email/get', { accountId: auth.accountId, ids: [emailId], properties: ['attachments', 'htmlBody', 'textBody'] }, '0']
	]);
	const list = (response.methodResponses[0]?.[1] as { list?: PartLists[] } | undefined)?.list ?? [];
	const types = new Map<string, string>();
	for (const email of list) {
		for (const key of ['attachments', 'htmlBody', 'textBody'] as const) {
			for (const part of email[key] ?? []) {
				if (part.blobId && part.type && !types.has(part.blobId)) types.set(part.blobId, part.type);
			}
		}
	}
	return types;
}

function partTypes(auth: AuthState, emailId: string): Promise<Map<string, string>> {
	const key = `${auth.accountId}/${emailId}`;
	const now = Date.now();
	const hit = partTypesCache.get(key);
	if (hit && now - hit.at < PART_TYPES_TTL_MS) return hit.types;
	const types = fetchPartTypes(auth, emailId).catch(() => {
		// A failed lookup is not an answer worth keeping.
		partTypesCache.delete(key);
		return new Map<string, string>();
	});
	if (partTypesCache.size >= PART_TYPES_MAX) {
		partTypesCache.delete(partTypesCache.keys().next().value as string);
	}
	partTypesCache.set(key, { at: now, types });
	return types;
}

/** A declared type worth using: a well-formed token and not the catch-all. */
function specificType(type: string | null | undefined): string | null {
	if (!type) return null;
	const token = type.split(';')[0].trim().toLowerCase();
	if (!MIME_TOKEN.test(token) || token === 'application/octet-stream') return null;
	return token;
}

function contentType(declared: string | undefined, upstream: string | null, filename: string): string {
	const ext = filename.toLowerCase().split('.').pop() ?? '';
	let type =
		specificType(declared) ?? specificType(upstream) ?? MIME_OVERRIDES[ext] ?? 'application/octet-stream';
	if (SERVED_AS_DOWNLOAD.test(type)) type = 'application/octet-stream';
	// Text read straight into a tab: the message's parts are UTF-8 once
	// Stalwart has decoded them, and the extension table says the same.
	if (type.startsWith('text/') && !type.includes(';')) type += '; charset=utf-8';
	return type;
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
	if (!JMAP_ID.test(params.blobId)) {
		return new Response('Invalid blob id', { status: 400 });
	}

	const filename = url.searchParams.get('name') ?? 'attachment';
	const disposition = url.searchParams.get('disposition') === 'inline' ? 'inline' : 'attachment';

	const downloadUrl =
		`${locals.auth.apiUrl}download/${locals.auth.accountId}/${params.blobId}/${encodeURIComponent(filename)}`;

	// The blob and the message's part types, side by side.
	const [res, types] = await Promise.all([
		fetch(downloadUrl, { headers: { Authorization: locals.auth.authHeader } }),
		partTypes(locals.auth, params.id)
	]);

	if (!res.ok) {
		return new Response('Download failed', { status: res.status });
	}

	const type = contentType(types.get(params.blobId), res.headers.get('Content-Type'), filename);

	const headers: Record<string, string> = {
		'Content-Type': type,
		'Content-Disposition': contentDisposition(disposition, filename),
		// Lock down inline-rendered SVGs / HTML attachments so they can't run
		// scripts, post forms or fetch tracking pixels through the viewer
		// iframe. `sandbox` also takes the response out of this origin, which
		// is what matters for an attachment opened in its own tab. Not for
		// PDFs: Chrome's viewer does not render a sandboxed PDF document.
		'Content-Security-Policy':
			"default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; form-action 'none'" +
			(type === 'application/pdf' ? '' : '; sandbox'),
		// Force the browser to trust our Content-Type rather than sniffing —
		// required for inline PDF rendering when the override above kicks in.
		'X-Content-Type-Options': 'nosniff'
	};
	// Forward the length only when it describes the bytes we send: fetch has
	// already undone any Content-Encoding, and an empty value is not a length.
	const length = res.headers.get('Content-Length');
	if (length && !res.headers.get('Content-Encoding')) headers['Content-Length'] = length;

	return new Response(res.body, { status: 200, headers });
};
