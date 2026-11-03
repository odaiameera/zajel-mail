import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { LookupAddress } from 'node:dns';

/**
 * Outbound fetch helper hardened for fetching avatars from arbitrary
 * sender-controlled domains. The sender's domain is untrusted input, so a
 * naive `fetch('https://' + domain + '/favicon.ico')` is an SSRF vector: a
 * crafted sender domain could resolve to a host on the homelab's private
 * network. Every request here:
 *   - is https-only (unless the caller opts into http),
 *   - has its hostname resolved and every resulting IP checked against
 *     private/loopback/link-local/reserved ranges before connecting,
 *   - re-checks the final URL host after redirects,
 *   - is bounded by a timeout and (for `safeFetch`) a hard byte cap.
 *
 * Caveat: this does not pin the socket to the vetted IP, so a determined DNS
 * rebind between our lookup and fetch's own lookup is theoretically possible.
 * For a single-tenant homelab that residual risk is acceptable; the common
 * "point a domain at 127.0.0.1 / 10.x" attack is blocked.
 */

const DEFAULT_TIMEOUT_MS = 3500;
const DEFAULT_MAX_BYTES = 256 * 1024;

// Present as a real browser. Many sites (OpenAI, anything behind a basic bot
// wall) return 403 to an unrecognized User-Agent, which would otherwise hide
// their favicon. This is a read-only GET of a public icon, so a browser UA is
// appropriate and standard for favicon fetchers.
const BROWSER_UA =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function ipIsPrivate(ip: string): boolean {
	const v = isIP(ip);
	if (v === 4) {
		const p = ip.split('.').map(Number);
		if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true;
		const [a, b] = p;
		if (a === 0 || a === 10 || a === 127) return true;
		if (a === 169 && b === 254) return true; // link-local
		if (a === 172 && b >= 16 && b <= 31) return true;
		if (a === 192 && b === 168) return true;
		if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
		if (a >= 224) return true; // multicast / reserved
		return false;
	}
	if (v === 6) {
		const lc = ip.toLowerCase().replace(/^\[|\]$/g, '');
		if (lc === '::1' || lc === '::') return true;
		if (/^fe[89ab]/.test(lc)) return true; // link-local, fe80::/10
		if (lc.startsWith('fec0')) return true; // deprecated site-local
		if (lc.startsWith('fc') || lc.startsWith('fd')) return true; // unique-local
		if (lc.startsWith('64:ff9b:')) return true; // NAT64 (may embed a private v4)
		if (lc.startsWith('2001:db8')) return true; // documentation
		if (lc.startsWith('2002:')) return true; // 6to4 (may embed a private v4)
		if (lc.startsWith('::ffff:')) return ipIsPrivate(lc.slice('::ffff:'.length)); // v4-mapped
		if (lc.startsWith('::') && lc.includes('.')) return true; // IPv4-compatible ::a.b.c.d
		return false;
	}
	return true; // not a parseable IP → treat as unsafe
}

/**
 * Why a fetch came back empty-handed. Only `unreachable` is worth trying
 * again soon: a host we refuse, a name that doesn't exist and a redirect
 * chain that never ends are answers, not outages.
 */
export type FetchFailure =
	| 'blocked'
	| 'unknown-host'
	| 'unreachable'
	| 'too-many-redirects'
	| 'too-large'
	| 'empty';

/** Null when the host may be connected to, else why it may not. */
async function hostFailure(hostname: string): Promise<FetchFailure | null> {
	const h = hostname.toLowerCase().replace(/\.$/, '');
	if (
		!h ||
		h === 'localhost' ||
		h.endsWith('.localhost') ||
		h.endsWith('.local') ||
		h.endsWith('.internal') ||
		h.endsWith('.lan') ||
		h.endsWith('.home')
	) {
		return 'blocked';
	}
	if (isIP(h)) return ipIsPrivate(h) ? 'blocked' : null;
	let results: LookupAddress[];
	try {
		results = await lookup(h, { all: true });
	} catch (err) {
		// ENOTFOUND is the resolver saying the name has no address; anything
		// else (EAI_AGAIN, a dead resolver) is the resolver failing to say.
		return (err as NodeJS.ErrnoException).code === 'ENOTFOUND' ? 'unknown-host' : 'unreachable';
	}
	if (!results.length) return 'unknown-host';
	return results.some((r) => ipIsPrivate(r.address)) ? 'blocked' : null;
}

export interface SafeFetchOptions {
	accept?: string;
	/** Covers the whole exchange, body included. */
	timeoutMs?: number;
	/** Also accept plain-http URLs (mail images still use them). */
	allowHttp?: boolean;
	/** Defaults to GET. A POST keeps its body across 307/308 and becomes a GET on any other redirect, as browsers do. */
	method?: 'GET' | 'POST';
	body?: string;
	contentType?: string;
	/** Told why a null came back, for callers that treat an outage differently from a refusal. */
	onFailure?: (failure: FetchFailure) => void;
}

export type FetchedBlob = { bytes: Buffer; contentType: string | null; status: number };

const MAX_REDIRECTS = 4;

/**
 * The vetted response, body unread, for callers that stream it on. The
 * timeout stays armed until the body has been read to its end, so a server
 * that sends headers promptly and then trickles bytes still gets cut off.
 * Null when the host was refused, could not be reached, or redirected too
 * often; `onFailure` says which.
 */
export async function safeFetchResponse(
	rawUrl: string,
	opts: SafeFetchOptions = {}
): Promise<Response | null> {
	const fail = (failure: FetchFailure): null => {
		opts.onFailure?.(failure);
		return null;
	};
	let target = rawUrl;
	let method = opts.method ?? 'GET';
	let body = method === 'POST' ? opts.body : undefined;

	// Follow redirects manually so EVERY hop's host is vetted before we connect
	// to it. With `redirect: 'follow'`, undici would resolve and connect to an
	// intermediate Location pointing at a private/link-local address before we
	// ever get to re-check the final URL — a blind-SSRF hole. Manual mode lets
	// us re-run the host check on each hop's target first.
	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		let url: URL;
		try {
			url = new URL(target);
		} catch {
			return fail('blocked');
		}
		if (url.protocol !== 'https:' && !(opts.allowHttp && url.protocol === 'http:')) return fail('blocked');
		const refused = await hostFailure(url.hostname);
		if (refused) return fail(refused);

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
		timer.unref?.();
		let res: Response;
		try {
			res = await fetch(url, {
				method,
				body,
				signal: controller.signal,
				redirect: 'manual',
				headers: {
					'User-Agent': BROWSER_UA,
					...(opts.accept ? { Accept: opts.accept } : {}),
					...(body !== undefined && opts.contentType ? { 'Content-Type': opts.contentType } : {})
				}
			});
		} catch {
			clearTimeout(timer);
			return fail('unreachable');
		}

		const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
		if (location) {
			clearTimeout(timer);
			// Nothing reads a redirect's body; let the socket go.
			void res.body?.cancel().catch(() => {});
			try {
				target = new URL(location, url).toString(); // re-vetted at loop top
			} catch {
				return fail('blocked');
			}
			if (res.status !== 307 && res.status !== 308) {
				method = 'GET';
				body = undefined;
			}
			continue;
		}

		return armed(res, timer);
	}

	return fail('too-many-redirects');
}

/** The response with its body wrapped so the timer is cleared once it has been read to the end. */
function armed(res: Response, timer: ReturnType<typeof setTimeout>): Response {
	if (!res.body) {
		clearTimeout(timer);
		return res;
	}
	const body = res.body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			flush() {
				clearTimeout(timer);
			}
		})
	);
	return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}

/** The whole body, capped at `maxBytes`; null past the cap or (unless `allowEmpty`) when there is none. */
export async function safeFetch(
	rawUrl: string,
	opts: SafeFetchOptions & {
		maxBytes?: number;
		/** Treat an empty body (a 204, say) as an answer rather than a failure. */
		allowEmpty?: boolean;
	} = {}
): Promise<FetchedBlob | null> {
	const res = await safeFetchResponse(rawUrl, opts);
	if (!res) return null;
	const fail = (failure: FetchFailure): null => {
		opts.onFailure?.(failure);
		return null;
	};

	const max = opts.maxBytes ?? DEFAULT_MAX_BYTES;
	const declared = Number(res.headers.get('content-length') ?? '');
	if (Number.isFinite(declared) && declared > max) {
		void res.body?.cancel().catch(() => {});
		return fail('too-large');
	}
	let bytes: Buffer | null;
	try {
		bytes = await readCapped(res, max);
	} catch {
		// The timer fired, or the connection dropped, part-way through the body.
		return fail('unreachable');
	}
	if (!bytes) return fail('too-large');
	if (bytes.length === 0 && !opts.allowEmpty) return fail('empty');
	return { bytes, contentType: res.headers.get('content-type'), status: res.status };
}

/** Read a response body, aborting if it exceeds `max` bytes (defends against
 *  an oversized or content-length-lying body). */
async function readCapped(res: Response, max: number): Promise<Buffer | null> {
	if (!res.body) {
		const ab = await res.arrayBuffer();
		if (ab.byteLength > max) return null;
		return Buffer.from(ab);
	}
	const reader = res.body.getReader();
	const chunks: Buffer[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (value) {
			total += value.byteLength;
			if (total > max) {
				await reader.cancel().catch(() => {});
				return null;
			}
			chunks.push(Buffer.from(value));
		}
	}
	return Buffer.concat(chunks);
}
