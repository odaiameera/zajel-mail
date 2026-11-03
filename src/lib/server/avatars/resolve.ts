import { createHash } from 'node:crypto';
import { resolveTxt } from 'node:dns/promises';
import { safeFetch, type FetchedBlob, type FetchFailure } from './net';
import { imageDimensions, imageSize, sniffImage } from './image';

/**
 * The individual avatar sources. Everything is fetched server-side, directly
 * from the sender's own domain / DNS (and gravatar.com), never via a
 * third-party logo aggregator — so no outside service learns who emails this
 * mailbox.
 *
 * Each source answers with a {@link Lookup}: the logo, a definite "none", or
 * "unreachable" when nothing answered at all. The cache keeps a "none" for a
 * week but an "unreachable" only for minutes: a two-minute uplink blip while
 * the inbox renders must not leave fifty senders on initials until next week.
 */

export interface Asset {
	contentType: string;
	bytes: Buffer;
	source: 'bimi' | 'favicon' | 'gravatar';
}

export type Lookup =
	| { outcome: 'found'; asset: Asset }
	/** The source answered: there is no logo here. */
	| { outcome: 'none' }
	/** No answer worth remembering: DNS or the network failed, or the server errored. */
	| { outcome: 'unreachable' };

const NONE: Lookup = { outcome: 'none' };
const UNREACHABLE: Lookup = { outcome: 'unreachable' };

/**
 * Tells a definite miss from an outage across the fetches a resolver makes.
 * `safeFetch` reports why each one failed; a host that refused us, a name
 * that does not exist or a body that was not an image are all answers.
 */
class Probe {
	unreachable = false;
	readonly onFailure = (failure: FetchFailure): void => {
		if (failure === 'unreachable') this.unreachable = true;
	};
	/** Note a response that arrived; a 5xx is the server failing, not declining. */
	saw(blob: FetchedBlob): void {
		if (blob.status >= 500) this.unreachable = true;
	}
	outcome(asset: Asset | null): Lookup {
		if (asset) return { outcome: 'found', asset };
		return this.unreachable ? UNREACHABLE : NONE;
	}
}

/**
 * Rasters wider or taller than this are not icons and are not served. A
 * favicon's bytes are capped at 256 KB, but a PNG that size can declare a
 * 40000x40000 canvas; drawing it (every row does, to pick a plate colour)
 * would have the browser allocate gigabytes. Real icons stop at 512.
 */
export const MAX_RASTER_SIDE = 1024;

function tooLarge(bytes: Buffer, mime: string): boolean {
	if (mime === 'image/svg+xml') return false;
	const dims = imageDimensions(bytes, mime);
	return dims !== null && Math.max(dims.width, dims.height) > MAX_RASTER_SIDE;
}

export function emailDomain(email: string): string {
	const at = email.lastIndexOf('@');
	return at >= 0 ? email.slice(at + 1).trim().toLowerCase() : '';
}

// Common multi-label public suffixes, so we strip a subdomain down to the
// right registrable domain (news.example.co.uk → example.co.uk, not co.uk).
// Not the full Public Suffix List — just the suffixes mail commonly comes from.
const MULTI_LABEL_TLDS = new Set([
	'co.uk', 'org.uk', 'me.uk', 'ac.uk', 'gov.uk', 'net.uk', 'sch.uk',
	'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'id.au',
	'co.nz', 'net.nz', 'org.nz', 'govt.nz',
	'co.jp', 'or.jp', 'ne.jp', 'ac.jp', 'go.jp',
	'co.kr', 'or.kr', 'go.kr',
	'com.br', 'net.br', 'org.br', 'gov.br',
	'com.cn', 'net.cn', 'org.cn', 'gov.cn',
	'co.in', 'net.in', 'org.in', 'gov.in',
	'co.za', 'org.za', 'co.il', 'co.id', 'co.th',
	'com.mx', 'com.ar', 'com.tr', 'com.sg', 'com.hk', 'com.tw',
	'com.sa', 'com.eg', 'com.my', 'com.ph', 'com.vn', 'com.ua'
]);

/**
 * Reduce a (possibly sub-)domain to its registrable root, used as a fallback
 * when the exact sender domain has no website/favicon of its own
 * (e.g. email.openai.com → openai.com, mg.news.brand.com → brand.com).
 */
export function registrableDomain(domain: string): string {
	const parts = domain.toLowerCase().split('.').filter(Boolean);
	if (parts.length <= 2) return parts.join('.');
	const lastTwo = parts.slice(-2).join('.');
	if (MULTI_LABEL_TLDS.has(lastTwo) && parts.length >= 3) return parts.slice(-3).join('.');
	return lastTwo;
}

// Shared mailbox providers. A person writing from one of these has no say
// over the domain's logo, and the homepage's icon would stamp the provider's
// mark on every one of them — and on anyone writing as "Google Security" from
// a gmail.com box, which really does come from gmail.com. The domain step is
// skipped for them, so only their own Gravatar can show.
const FREEMAIL_DOMAINS = new Set([
	'gmail.com', 'googlemail.com',
	'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
	'yahoo.com', 'ymail.com', 'rocketmail.com', 'aol.com',
	'icloud.com', 'me.com', 'mac.com',
	'proton.me', 'protonmail.com', 'protonmail.ch', 'pm.me',
	'gmx.com', 'gmx.net', 'gmx.de', 'gmx.at', 'gmx.ch', 'web.de', 'mail.com', 't-online.de', 'freenet.de', 'posteo.de', 'posteo.net', 'mailbox.org',
	'fastmail.com', 'fastmail.fm', 'hey.com', 'zoho.com', 'zohomail.com', 'tutanota.com', 'tutamail.com', 'tuta.com', 'tuta.io', 'hushmail.com', 'runbox.com', 'duck.com',
	'yandex.com', 'yandex.ru', 'mail.ru', 'qq.com', '163.com', '126.com', 'naver.com', 'daum.net', 'hanmail.net', 'rediffmail.com',
	'laposte.net', 'orange.fr', 'wanadoo.fr', 'free.fr', 'sfr.fr', 'libero.it', 'virgilio.it', 'seznam.cz',
	'comcast.net', 'verizon.net', 'att.net', 'sbcglobal.net', 'bellsouth.net', 'cox.net', 'btinternet.com', 'sky.com'
]);
// The big providers under any country suffix: yahoo.co.uk, hotmail.fr, live.nl, …
const FREEMAIL_BRANDS = new Set(['gmail', 'googlemail', 'hotmail', 'outlook', 'live', 'yahoo', 'ymail', 'aol', 'gmx', 'protonmail', 'icloud']);

/** Does this sender domain belong to a provider whose users are not its brand? */
export function isFreemailDomain(domain: string): boolean {
	const root = registrableDomain(domain);
	return FREEMAIL_DOMAINS.has(root) || FREEMAIL_BRANDS.has(root.split('.')[0]);
}

// DNS-over-HTTPS fallback for TXT lookups. Some networks/hosts refuse TXT
// queries to the system resolver (you get EREFUSED/SERVFAIL), which silently
// breaks BIMI — and BIMI is the ONLY way to get a logo for brands that block
// direct favicon fetches (e.g. Financial Times serves a 403 to everything).
// We only escalate to DoH when the local resolver *can't answer at all*; a
// genuine "no record" (ENOTFOUND/ENODATA) needs no fallback, so on a healthy
// network this never fires and no domain is sent to the DoH provider.
// Set to '' to disable the fallback entirely.
const BIMI_DOH_URL = 'https://cloudflare-dns.com/dns-query';

/** The records, or null when the provider could not answer either. */
async function dohTxt(name: string): Promise<string[] | null> {
	if (!BIMI_DOH_URL) return null;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 3000);
	try {
		const res = await fetch(`${BIMI_DOH_URL}?name=${encodeURIComponent(name)}&type=TXT`, {
			headers: { accept: 'application/dns-json' },
			signal: controller.signal
		});
		if (!res.ok) return null;
		const json = (await res.json()) as { Answer?: Array<{ data?: string }> };
		return (json.Answer ?? [])
			// TXT data arrives quoted, and long records arrive as "chunk1" "chunk2";
			// drop the inter-chunk separators, then the surrounding quotes.
			.map((a) => (a.data ?? '').replace(/"\s+"/g, '').replace(/"/g, ''))
			.filter(Boolean);
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

/** TXT records for `name`: `[]` when there are none, null when nobody could tell us. */
async function lookupTxt(name: string): Promise<string[] | null> {
	try {
		const records = await resolveTxt(name);
		return records.map((parts) => parts.join(''));
	} catch (err) {
		const code = (err as NodeJS.ErrnoException)?.code;
		// Real "no such record" — don't bother the DoH provider.
		if (code === 'ENOTFOUND' || code === 'ENODATA') return [];
		// Resolver couldn't answer (EREFUSED/SERVFAIL/ETIMEOUT/…) — try DoH.
		return dohTxt(name);
	}
}

/** BIMI: a DNS-published brand logo (SVG). The gold standard for company marks. */
export async function resolveBimi(domain: string): Promise<Lookup> {
	const records = await lookupTxt(`default._bimi.${domain}`);
	if (records === null) return UNREACHABLE;
	const txt = records.find((t) => /v=BIMI1/i.test(t));
	if (!txt) return NONE;
	const url = txt.match(/(?:^|;)\s*l\s*=\s*([^;]+)/i)?.[1]?.trim();
	if (!url) return NONE;

	const probe = new Probe();
	const blob = await safeFetch(url, {
		accept: 'image/svg+xml',
		timeoutMs: 3000,
		maxBytes: 128 * 1024,
		onFailure: probe.onFailure
	});
	if (!blob) return probe.outcome(null);
	probe.saw(blob);
	if (blob.status !== 200) return probe.outcome(null);
	// BIMI requires SVG Tiny PS — anything else is non-conformant, skip it.
	if (sniffImage(blob.bytes) !== 'image/svg+xml') return NONE;
	return { outcome: 'found', asset: { contentType: 'image/svg+xml', bytes: blob.bytes, source: 'bimi' } };
}

const LINK_TAG_RE = /<link\b[^>]*>/gi;

/**
 * Every icon link in a homepage's <head>, best first.
 *
 * This used to return only the single highest-scoring link, which is how
 * low-resolution avatars got in: a site declaring a 16x16 .ico in <head> had
 * that one candidate tried, and if it fetched successfully the 180px
 * apple-touch-icon below was never reached. Returning the ranked list lets the
 * caller keep looking for something bigger.
 *
 * Vector icons score highest — an SVG is sharp at any size, which is the whole
 * problem here — then declared `sizes`, then the apple-touch convention (180px
 * by convention, and usually a clean square mark).
 */
function iconHrefs(html: string, baseUrl: string): string[] {
	const found: Array<{ href: string; score: number }> = [];
	for (const tag of html.match(LINK_TAG_RE) ?? []) {
		if (!/\brel\s*=\s*["'][^"']*icon[^"']*["']/i.test(tag)) continue;
		const href = tag.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1];
		if (!href) continue;

		let score = 1;
		if (/apple-touch-icon/i.test(tag)) score = 6;
		const size = tag.match(/\bsizes\s*=\s*["'](\d+)x\d+["']/i);
		if (size) score = Math.max(score, Math.min(9, Math.floor(Number(size[1]) / 32) + 2));
		if (/\.svg\b/i.test(href) || /type\s*=\s*["']image\/svg/i.test(tag)) score = 10;

		try {
			const url = new URL(href, baseUrl);
			// An inline data: icon cannot be fetched and would only use up a slot.
			if (url.protocol === 'https:' || url.protocol === 'http:') found.push({ href: url.toString(), score });
		} catch {
			// skip unparseable href
		}
	}
	found.sort((a, b) => b.score - a.score);

	// De-duplicate, keeping the best-scoring occurrence of each URL.
	const seen = new Set<string>();
	return found.filter(({ href }) => !seen.has(href) && seen.add(href)).map((f) => f.href);
}

/**
 * Stop looking once a candidate is this big. Rows draw avatars at 32-40 CSS
 * px, so 128 already covers a retina display with room to spare; anything
 * larger cannot look better and only costs another round-trip.
 */
const IDEAL_SIZE = 128;

/** Bound on how many candidate URLs we will actually fetch per domain. */
const MAX_ICON_FETCHES = 5;

/**
 * Favicon: parse the homepage for declared icons, else try well-known paths,
 * and keep the highest-resolution one rather than the first that parses.
 *
 * Taking the first working candidate is what produced blurry avatars — plenty
 * of sites still declare a 16x16 .ico first. Each candidate's real pixel size
 * is read from its header (see `imageSize`), so the choice is made on what the
 * bytes actually are, not on what the markup claims.
 */
export async function resolveFavicon(domain: string): Promise<Lookup> {
	const probe = new Probe();
	const candidates: string[] = [];

	const home = await safeFetch(`https://${domain}/`, {
		accept: 'text/html',
		timeoutMs: 3000,
		maxBytes: 512 * 1024,
		onFailure: probe.onFailure
	});
	if (home) probe.saw(home);
	if (home && home.status === 200 && /text\/html/i.test(home.contentType ?? '')) {
		candidates.push(...iconHrefs(home.bytes.toString('utf8'), `https://${domain}/`));
	}
	// Conventional locations, best first: a vector mark, then the apple-touch
	// convention (180px), then the 16x16-era .ico as a last resort.
	candidates.push(
		`https://${domain}/favicon.svg`,
		`https://${domain}/apple-touch-icon.png`,
		`https://${domain}/apple-touch-icon-precomposed.png`,
		`https://${domain}/favicon.ico`
	);

	const seen = new Set<string>();
	let best: { asset: Asset; size: number } | null = null;
	let fetches = 0;

	for (const url of candidates) {
		if (seen.has(url)) continue;
		seen.add(url);
		if (fetches >= MAX_ICON_FETCHES) break;
		fetches++;

		const blob = await safeFetch(url, {
			accept: 'image/*',
			timeoutMs: 3000,
			maxBytes: 256 * 1024,
			onFailure: probe.onFailure
		});
		if (!blob) continue;
		probe.saw(blob);
		if (blob.status !== 200) continue;
		const mime = sniffImage(blob.bytes);
		if (!mime) continue; // not a real image (e.g. SPA returned index.html)
		if (tooLarge(blob.bytes, mime)) continue; // a canvas, not an icon

		const size = imageSize(blob.bytes, mime);
		if (!best || size > best.size) {
			best = { asset: { contentType: mime, bytes: blob.bytes, source: 'favicon' }, size };
		}
		// Good enough that a further round-trip cannot improve it.
		if (size >= IDEAL_SIZE) break;
	}

	// A small mark is still served if it is all the domain offers — a soft
	// logo beats a bare initial — but only after every larger candidate above
	// has had its chance.
	return probe.outcome(best?.asset ?? null);
}

/** Gravatar: a globally-recognised avatar for the exact address. d=404 makes
 *  "no avatar set" a clean 404 we can negative-cache. */
export async function resolveGravatar(email: string): Promise<Lookup> {
	const hash = createHash('md5').update(email.trim().toLowerCase()).digest('hex');
	const probe = new Probe();
	// s=256: avatars are drawn up to 80 CSS px (profile card, account rows),
	// which is 160 device pixels on a retina display; 160 was exactly at that
	// limit with nothing spare. Still a small JPEG/PNG at this size.
	const blob = await safeFetch(`https://www.gravatar.com/avatar/${hash}?d=404&s=256`, {
		accept: 'image/*',
		timeoutMs: 3000,
		maxBytes: 256 * 1024,
		// The 404 for "no avatar" has no body; it is the answer we want to keep.
		allowEmpty: true,
		onFailure: probe.onFailure
	});
	if (!blob) return probe.outcome(null);
	probe.saw(blob);
	if (blob.status !== 200) return probe.outcome(null);
	const mime = sniffImage(blob.bytes);
	if (!mime || tooLarge(blob.bytes, mime)) return NONE;
	return { outcome: 'found', asset: { contentType: mime, bytes: blob.bytes, source: 'gravatar' } };
}
