import type { RequestHandler } from './$types';
import { safeFetchResponse } from '$lib/server/avatars/net';
import { sniffImage } from '$lib/server/avatars/image';

/**
 * GET /api/image-proxy?url=<remote image>
 *
 * Fetches a remote image referenced by an email body and serves it from this
 * origin (the reading view rewrites every remote <img> to point here — see
 * `$lib/utils/email-images`). Loaded directly, a sender's images can be
 * refused by the browser — LinkedIn's CDN answers cross-site loads with
 * `Cross-Origin-Resource-Policy`, other hosts check the Referer, content
 * blockers drop tracker and social domains, and http images are mixed
 * content. Fetched from here, none of that applies, and the sender's
 * tracking pixel sees this server rather than the reader's IP and browser.
 *
 * The target is attacker-controlled (anyone can email you), so:
 *  - only a signed-in session may use it,
 *  - `safeFetchResponse` refuses private/loopback addresses on every redirect
 *    hop and keeps its timer armed until the body has been read,
 *  - the first kilobyte must sniff as an image — the upstream Content-Type is
 *    never trusted or echoed — and the rest is streamed through, cut off
 *    past the byte cap, rather than held in memory,
 *  - the response is locked down like the avatar endpoint, because a
 *    same-origin SVG opened directly would otherwise run its scripts,
 *  - only a few run at once. Each one holds a slot until its bytes have been
 *    passed on, and the sender decides how many images a message has and how
 *    big each is, so without a gate a message of 300 ten-megabyte pictures
 *    would have the server relay them all at once.
 */

const MAX_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 10_000;
const ACCEPT = 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8';
/** Enough of the start to tell what it is: `sniffImage` looks this far for an <svg>. */
const SNIFF_BYTES = 1024;

// The gate: this many fetches in flight, this many more waiting their turn,
// and a 503 beyond that so the browser's own retry (and the next scroll)
// picks the image up rather than the queue growing without bound.
const MAX_IN_FLIGHT = 8;
const MAX_WAITING = 32;
let inFlight = 0;
const waiting: Array<() => void> = [];

/** A turn to fetch, or false when the queue is full. */
function acquire(): Promise<boolean> {
	if (inFlight < MAX_IN_FLIGHT) {
		inFlight++;
		return Promise.resolve(true);
	}
	if (waiting.length >= MAX_WAITING) return Promise.resolve(false);
	return new Promise((resolve) => {
		waiting.push(() => {
			inFlight++;
			resolve(true);
		});
	});
}

function release(): void {
	inFlight--;
	waiting.shift()?.();
}

/** AVIF isn't in the avatar sniffer (favicons never use it); mail does. */
function sniffAvif(bytes: Buffer): string | null {
	if (bytes.length < 12 || bytes.toString('ascii', 4, 8) !== 'ftyp') return null;
	const brand = bytes.toString('ascii', 8, 12);
	return brand === 'avif' || brand === 'avis' ? 'image/avif' : null;
}

function failure(status: number): Response {
	// Not cached: a CDN hiccup should not leave a hole in the email for a day.
	return new Response(null, { status, headers: { 'Cache-Control': 'no-store' } });
}

export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) return failure(401);

	const target = url.searchParams.get('url');
	if (!target || target.length > 4096) return failure(400);
	let parsed: URL;
	try {
		parsed = new URL(target);
	} catch {
		return failure(400);
	}
	if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return failure(400);

	if (!(await acquire())) {
		const busy = failure(503);
		busy.headers.set('Retry-After', '2');
		return busy;
	}
	// The slot is given back once, whichever way this ends.
	let released = false;
	const done = (): void => {
		if (released) return;
		released = true;
		release();
	};

	const upstream = await safeFetchResponse(parsed.toString(), {
		accept: ACCEPT,
		timeoutMs: TIMEOUT_MS,
		allowHttp: true
	});
	if (!upstream || upstream.status < 200 || upstream.status >= 300 || !upstream.body) {
		void upstream?.body?.cancel().catch(() => {});
		done();
		return failure(502);
	}
	const declared = Number(upstream.headers.get('content-length') ?? '');
	if (Number.isFinite(declared) && declared > MAX_BYTES) {
		void upstream.body.cancel().catch(() => {});
		done();
		return failure(502);
	}

	const reader = upstream.body.getReader();
	const refuse = async (status: number): Promise<Response> => {
		await reader.cancel().catch(() => {});
		done();
		return failure(status);
	};

	const head: Uint8Array[] = [];
	let total = 0;
	try {
		while (total < SNIFF_BYTES) {
			const { done: ended, value } = await reader.read();
			if (ended) break;
			head.push(value);
			total += value.byteLength;
		}
	} catch {
		return refuse(502);
	}
	if (total > MAX_BYTES) return refuse(502);
	const start = Buffer.concat(head);
	const type = sniffImage(start) ?? sniffAvif(start);
	if (!type) return refuse(415);

	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new Uint8Array(start));
		},
		async pull(controller) {
			let chunk: ReadableStreamReadResult<Uint8Array>;
			try {
				chunk = await reader.read();
			} catch (err) {
				controller.error(err);
				done();
				return;
			}
			if (chunk.done) {
				controller.close();
				done();
				return;
			}
			total += chunk.value.byteLength;
			if (total > MAX_BYTES) {
				// The sender omitted or understated Content-Length. The headers
				// are out, so the stream is cut rather than answered with a 413.
				await reader.cancel().catch(() => {});
				controller.error(new Error('image exceeds the size limit'));
				done();
				return;
			}
			controller.enqueue(chunk.value);
		},
		cancel() {
			void reader.cancel().catch(() => {});
			done();
		}
	});

	return new Response(body, {
		status: 200,
		headers: {
			'Content-Type': type,
			'Cache-Control': 'private, max-age=86400',
			'X-Content-Type-Options': 'nosniff',
			'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
			'Content-Disposition': 'inline; filename="image"',
			'Referrer-Policy': 'no-referrer'
		}
	});
};
