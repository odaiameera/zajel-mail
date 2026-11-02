import type { EmailAttachment } from '$lib/jmap/types';
import { attachmentUrl } from '$lib/attachments/fetch';

/**
 * Point every image in an email body somewhere the browser can actually load
 * it from, for the reading view only (replies and forwards keep the sender's
 * original URLs).
 *
 *  - Remote `http(s)` images go through `/api/image-proxy`. Loading them
 *    straight from the sender's CDN fails for a whole class of senders:
 *    LinkedIn and others serve images with `Cross-Origin-Resource-Policy`
 *    or referrer checks that refuse any page but their own, content blockers
 *    drop anything on a "social" or tracker domain, and plain-http images are
 *    blocked as mixed content. Fetched server-side, the image arrives from
 *    this origin and none of that applies — and the sender's tracker sees
 *    the server, not the reader's IP address and browser.
 *  - `cid:` images (inline parts of a multipart/related message) are
 *    resolved to the part itself; the browser has no idea what `cid:` means.
 *
 * String-based rather than DOM-based because the body is also rendered
 * during SSR, where there is no DOMParser. Every scan here is a single pass
 * over the body ({@link transformTags}, {@link rewriteCss}): the body is the
 * sender's, and a pattern that backtracks over it from every `<` would let a
 * few hundred kilobytes of `<link ` hold the server's one thread for minutes.
 */

export const IMAGE_PROXY_PATH = '/api/image-proxy';

/** What a blocked or unloadable image reference becomes: a URL that fetches nothing. */
export const BLOCKED_URL = 'about:invalid';

/**
 * Bodies longer than this are shown as text instead of being laid out. A real
 * HTML message is a few hundred kilobytes at most (Gmail clips at 102 KB);
 * far past that it is something to read as source, and the cap bounds what
 * preparing one message can cost.
 */
export const MAX_HTML_LENGTH = 2 * 1024 * 1024;

export interface EmailImageContext {
	emailId: string;
	/** The email's attachments; inline parts carry the `cid` images refer to. */
	attachments: EmailAttachment[];
	/**
	 * `proxy` (the default) loads remote images through the image proxy;
	 * `block` replaces them with {@link BLOCKED_URL} — the reader's
	 * "don't load remote images" choice. Inline `cid:` and `data:` images
	 * are never remote and always show.
	 */
	remote?: 'proxy' | 'block';
}

export interface PreparedEmail {
	html: string;
	/** Remote images left out because `remote` was `block`. */
	blockedRemote: number;
	/** Blob ids of the parts the body draws through `cid:`, so they are not also listed as attachments. */
	inlineBlobIds: Set<string>;
}

interface RewriteCtx {
	cids: Map<string, EmailAttachment>;
	emailId: string;
	base: string | null;
	remote: 'proxy' | 'block';
	/** Remote image references replaced because `remote` is `block`. */
	blocked: number;
	/** Blob ids of the `cid:` parts a reference resolved to. */
	inline: Set<string>;
}

/**
 * Percent-encode everything but unreserved characters, so the result is safe
 * unquoted in an attribute, inside CSS `url()`, and between srcset commas.
 */
function encodeParam(value: string): string {
	return encodeURIComponent(value).replace(
		/[!'()*]/g,
		(c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
	);
}

export function proxiedImageUrl(url: string): string {
	return `${IMAGE_PROXY_PATH}?url=${encodeParam(url)}`;
}

const ENTITY = /&(#\d+|#x[0-9a-f]+|amp|quot|apos|lt|gt);/gi;
const NAMED: Record<string, string> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' };

function decodeEntities(value: string): string {
	return value.replace(ENTITY, (whole, body: string) => {
		const lower = body.toLowerCase();
		if (lower in NAMED) return NAMED[lower];
		const code = lower.startsWith('#x') ? parseInt(lower.slice(2), 16) : parseInt(lower.slice(1), 10);
		return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
	});
}

function escapeAttr(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

function escapeHtml(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The new URL for one image reference, or null to leave it untouched. */
function rewriteUrl(raw: string, ctx: RewriteCtx): string | null {
	const value = raw.trim();
	if (!value) return null;

	if (/^cid:/i.test(value)) {
		let id = value.slice(4).replace(/^<|>$/g, '');
		try {
			// RFC 2392: a cid URL is the Content-ID with URL escaping applied.
			id = decodeURIComponent(id);
		} catch {
			// Malformed escape — match it as written.
		}
		const part = ctx.cids.get(id) ?? ctx.cids.get(id.toLowerCase());
		if (!part) return null;
		ctx.inline.add(part.blobId);
		return attachmentUrl(ctx.emailId, part.blobId, part.name ?? 'image', 'inline');
	}

	let absolute: string;
	if (/^https?:\/\//i.test(value)) absolute = value;
	else if (value.startsWith('//')) absolute = `https:${value}`;
	else if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return null; // data:, blob: or some other scheme
	else if (ctx.base) {
		try {
			absolute = new URL(value, ctx.base).toString();
		} catch {
			return BLOCKED_URL;
		}
	} else {
		// Relative with no <base> to resolve it against. The reading view is
		// on this origin, so this would be a request to the webmail itself —
		// `/api/…` with the reader's cookies, or `/api/image-proxy?url=` to
		// sneak a tracker past the remote-image setting. Nothing legitimate
		// lives there, so it loads nothing.
		return BLOCKED_URL;
	}

	if (ctx.remote === 'block') {
		ctx.blocked++;
		return BLOCKED_URL;
	}
	return proxiedImageUrl(absolute);
}

/**
 * srcset is `url descriptor, url descriptor`, but a URL may itself contain
 * commas, so this follows the spec's tokenizer (a URL runs to whitespace)
 * instead of splitting on ','.
 */
function rewriteSrcset(value: string, ctx: RewriteCtx): string {
	const out: string[] = [];
	let i = 0;
	while (i < value.length) {
		while (i < value.length && /[\s,]/.test(value[i])) i++;
		if (i >= value.length) break;
		let start = i;
		while (i < value.length && !/\s/.test(value[i])) i++;
		let url = value.slice(start, i);
		let descriptor = '';
		if (url.endsWith(',')) {
			url = url.replace(/,+$/, '');
		} else {
			start = i;
			while (i < value.length && value[i] !== ',') i++;
			descriptor = value.slice(start, i).trim();
		}
		const next = rewriteUrl(url, ctx) ?? url;
		out.push(descriptor ? `${next} ${descriptor}` : next);
	}
	return out.join(', ');
}

// What CSS can load: url() images, which are rewritten, and @import
// stylesheets and @font-face fonts, which are left alone — the proxy only
// serves images, and the reading view's CSP (emailFrameCsp) is what stops
// them loading.
const CSS_TOKEN = /url\(|@import\b|@font-face\b/gi;

/** CSS whitespace: space, tab, newline, carriage return, form feed. */
function isCssWs(code: number): boolean {
	return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d || code === 0x0c;
}

/**
 * One left-to-right pass: each token is handled where it is found and the
 * scan resumes after it, so the cost is the length of the CSS however it is
 * shaped (`url(url(url(` or `@font-face` a thousand times included).
 */
function rewriteCss(css: string, ctx: RewriteCtx): string {
	const out: string[] = [];
	let last = 0;
	// Once a search for one of these has come up empty there is none later.
	let noBrace = false;
	CSS_TOKEN.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = CSS_TOKEN.exec(css))) {
		let next = m.index + m[0].length;
		// An at-rule starts with '@'; `@import` is the shorter of the two.
		const atRule = m[0].charCodeAt(0) === 0x40;
		if (atRule && m[0].length === 7) {
			const end = css.indexOf(';', next);
			if (end === -1) break; // runs to the end of the sheet
			next = end + 1;
		} else if (atRule) {
			const open = noBrace ? -1 : css.indexOf('{', next);
			if (open === -1) {
				noBrace = true;
			} else {
				const close = css.indexOf('}', open + 1);
				if (close === -1) break; // an unclosed block is the rest of the sheet
				next = close + 1;
			}
		} else {
			const arg = cssUrlArgument(css, next);
			if (arg === 'unterminated') break;
			if (arg) {
				next = arg.end;
				const rewritten = rewriteUrl(decodeCssEscapes(arg.value), ctx);
				if (rewritten !== null) {
					out.push(
						css.slice(last, m.index),
						`url("${rewritten.replace(/["\\\n\r]/g, (c) => encodeURIComponent(c))}")`
					);
					last = next;
				}
			}
		}
		CSS_TOKEN.lastIndex = next;
	}
	if (last === 0) return css;
	out.push(css.slice(last));
	return out.join('');
}

/**
 * The argument of a `url(` whose parenthesis ends just before `from`, and
 * where its `)` ends. Null when what follows is not a url() after all;
 * 'unterminated' when a quoted argument never closes (nothing after it can be
 * a url() either).
 */
function cssUrlArgument(
	css: string,
	from: number
): { value: string; end: number } | 'unterminated' | null {
	const n = css.length;
	let i = from;
	while (i < n && isCssWs(css.charCodeAt(i))) i++;
	const quote = css.charCodeAt(i);
	let value: string;
	if (quote === 0x22 || quote === 0x27) {
		const close = css.indexOf(css[i], i + 1);
		if (close === -1) return 'unterminated';
		value = css.slice(i + 1, close);
		i = close + 1;
	} else {
		// An unquoted url stops at whitespace, a quote or either parenthesis.
		const start = i;
		while (i < n) {
			const c = css.charCodeAt(i);
			if (c === 0x28 || c === 0x29 || c === 0x22 || c === 0x27 || isCssWs(c)) break;
			i++;
		}
		value = css.slice(start, i);
	}
	while (i < n && isCssWs(css.charCodeAt(i))) i++;
	if (css.charCodeAt(i) !== 0x29) return null;
	return { value, end: i + 1 };
}

function decodeCssEscapes(value: string): string {
	return value.replace(/\\([0-9a-f]{1,6}\s?|.)/gi, (_, esc: string) => {
		const hex = esc.trim();
		if (/^[0-9a-f]+$/i.test(hex) && esc.length > 1) {
			const code = parseInt(hex, 16);
			return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
		}
		return esc;
	});
}

interface StartTag {
	name: string;
	lowerName: string;
	/** Everything between the name and the closing `>`, leading space included. */
	attrs: string;
	/** The whole tag, `<` to `>`. */
	raw: string;
}

const STYLE_END = /<\/style\s*>/gi;

function isNameStart(code: number): boolean {
	return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

function isNameChar(code: number): boolean {
	return isNameStart(code) || (code >= 0x30 && code <= 0x39) || code === 0x3a || code === 0x2d;
}

/**
 * Walk the start tags of `html` once, left to right, the way a browser's
 * tokenizer does: a tag runs to the first `>` outside quotes, a comment to
 * `-->`, and a `<style>` element's text to `</style>`. `visitTag` returns the
 * replacement for a tag, or null to keep it; `visitStyle` the replacement for
 * a style element's CSS. A tag or comment that never closes swallows the rest
 * of the document in a browser, so nothing after it is rendered — and nothing
 * after it is scanned again here, which is what keeps this linear.
 */
function transformTags(
	html: string,
	visitTag: (tag: StartTag) => string | null,
	visitStyle: (css: string) => string
): string {
	const n = html.length;
	const out: string[] = [];
	let last = 0;
	let i = 0;
	while (i < n) {
		const lt = html.indexOf('<', i);
		if (lt === -1) break;
		const code = html.charCodeAt(lt + 1);
		if (code === 0x21 /* ! */) {
			if (html.startsWith('<!--', lt)) {
				const end = html.indexOf('-->', lt + 4);
				if (end === -1) break;
				i = end + 3;
			} else {
				const end = html.indexOf('>', lt + 2);
				if (end === -1) break;
				i = end + 1;
			}
			continue;
		}
		if (code === 0x2f /* / */) {
			const end = html.indexOf('>', lt + 2);
			if (end === -1) break;
			i = end + 1;
			continue;
		}
		if (!isNameStart(code)) {
			i = lt + 1;
			continue;
		}

		let j = lt + 1;
		while (j < n && isNameChar(html.charCodeAt(j))) j++;
		// Attributes run to the first '>' outside quotes.
		let k = j;
		let closed = false;
		while (k < n) {
			const c = html.charCodeAt(k);
			if (c === 0x3e /* > */) {
				closed = true;
				break;
			}
			if (c === 0x22 || c === 0x27) {
				const q = html.indexOf(html[k], k + 1);
				if (q === -1) {
					k = n;
					break;
				}
				k = q + 1;
				continue;
			}
			k++;
		}
		if (!closed) break;

		const name = html.slice(lt + 1, j);
		const tag: StartTag = {
			name,
			lowerName: name.toLowerCase(),
			attrs: html.slice(j, k),
			raw: html.slice(lt, k + 1)
		};
		const replaced = visitTag(tag);
		let next = k + 1;
		if (tag.lowerName === 'style') {
			STYLE_END.lastIndex = next;
			const close = STYLE_END.exec(html);
			const cssEnd = close ? close.index : n;
			const css = html.slice(next, cssEnd);
			const rewritten = visitStyle(css);
			if (replaced !== null || rewritten !== css) {
				out.push(html.slice(last, lt), replaced ?? tag.raw, rewritten);
				last = cssEnd;
			}
			next = cssEnd;
		} else if (replaced !== null) {
			out.push(html.slice(last, lt), replaced);
			last = next;
		}
		i = next;
	}
	if (last === 0) return html;
	out.push(html.slice(last));
	return out.join('');
}

// An attribute inside one tag's attribute string.
const ATTR = /(\s)([^\s"'>/=]+)(?:(\s*=\s*)("[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g;

function rewriteTag(tag: StartTag, ctx: RewriteCtx): string | null {
	const lowerName = tag.lowerName;
	let changed = false;
	const nextAttrs = tag.attrs.replace(ATTR, (whole, space: string, attrName: string, _eq, rawValue?: string) => {
		if (rawValue === undefined) return whole;
		const key = attrName.toLowerCase();
		const quoted = rawValue.startsWith('"') || rawValue.startsWith("'");
		const value = decodeEntities(quoted ? rawValue.slice(1, -1) : rawValue);

		let next: string | null = null;
		if (key === 'src' && (lowerName === 'img' || lowerName === 'input')) next = rewriteUrl(value, ctx);
		else if (key === 'srcset' && (lowerName === 'img' || lowerName === 'source')) {
			const rewritten = rewriteSrcset(value, ctx);
			next = rewritten === value ? null : rewritten;
		} else if (key === 'background' || (key === 'poster' && lowerName === 'video')) {
			next = rewriteUrl(value, ctx);
		} else if ((key === 'href' || key === 'xlink:href') && (lowerName === 'image' || lowerName === 'feimage')) {
			// SVG's way of drawing a picture: the same request as an <img>.
			next = rewriteUrl(value, ctx);
		} else if (key === 'style') {
			const rewritten = rewriteCss(value, ctx);
			next = rewritten === value ? null : rewritten;
		}

		if (next === null) return whole;
		changed = true;
		return `${space}${attrName}="${escapeAttr(next)}"`;
	});
	return changed ? `<${tag.name}${nextAttrs}>` : null;
}

const BASE_HREF = /\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
// A meta refresh navigates the frame itself — to a tracker, or a phishing page.
const REFRESH = /\shttp-equiv\s*=\s*(?:"\s*refresh\s*"|'\s*refresh\s*'|refresh\b)/i;

export function rewriteEmailImages(html: string, context: EmailImageContext): string {
	return rewrite(html, context, false).html;
}

/**
 * `strip` also removes what loads or navigates outside an image rule's reach:
 * <link> covers stylesheets but also dns-prefetch, preconnect and prefetch,
 * which reach the sender's host without any CSP directive applying, and a
 * meta refresh moves the frame wherever the sender likes.
 */
function rewrite(
	html: string,
	context: EmailImageContext,
	strip: boolean
): { html: string; blocked: number; inline: Set<string> } {
	const inline = new Set<string>();
	if (!html) return { html, blocked: 0, inline };

	const cids = new Map<string, EmailAttachment>();
	for (const part of context.attachments) {
		if (!part.cid) continue;
		if (!cids.has(part.cid)) cids.set(part.cid, part);
		const lower = part.cid.toLowerCase();
		if (!cids.has(lower)) cids.set(lower, part);
	}
	const ctx: RewriteCtx = {
		cids,
		emailId: context.emailId,
		base: null,
		remote: context.remote ?? 'proxy',
		blocked: 0,
		inline
	};

	// A sender's <base href> would re-root our /api/image-proxy URLs onto the
	// sender's own host. Take its href first, to resolve relative image paths
	// the way the sender meant; the element itself goes in the pass below.
	transformTags(
		html,
		(tag) => {
			if (tag.lowerName === 'base' && !ctx.base) {
				const href = BASE_HREF.exec(tag.attrs);
				const value = href ? decodeEntities(href[1] ?? href[2] ?? href[3] ?? '').trim() : '';
				if (/^https?:\/\//i.test(value)) ctx.base = value;
			}
			return null;
		},
		(css) => css
	);

	const out = transformTags(
		html,
		(tag) => {
			if (tag.lowerName === 'base') return '';
			if (strip) {
				if (tag.lowerName === 'link') return '';
				if (tag.lowerName === 'meta') return REFRESH.test(tag.attrs) ? '' : null;
			}
			return rewriteTag(tag, ctx);
		},
		(css) => rewriteCss(css, ctx)
	);
	return { html: out, blocked: ctx.blocked, inline };
}

/**
 * The body exactly as the reading view shows it: images rewritten per
 * {@link rewriteEmailImages}, plus the elements that load or navigate
 * outside what an image rule can stop removed. `blockedRemote` counts the
 * remote images left out, so the view can offer to load them, and
 * `inlineBlobIds` says which parts the body drew itself. A body past
 * {@link MAX_HTML_LENGTH} is shown as text.
 */
export function prepareEmailForReading(html: string, context: EmailImageContext): PreparedEmail {
	if (html.length > MAX_HTML_LENGTH) {
		return {
			html: `<pre style="white-space: pre-wrap; font-family: inherit;">${escapeHtml(html)}</pre>`,
			blockedRemote: 0,
			inlineBlobIds: new Set()
		};
	}
	const { html: out, blocked, inline } = rewrite(html, context, true);
	return { html: out, blockedRemote: blocked, inlineBlobIds: inline };
}

/**
 * Content-Security-Policy for the reading view's iframe, delivered as a
 * `<meta>` at the top of its srcdoc.
 *
 * The rewrite above is the first line; this is the one that holds when a
 * construct slips past a string rewrite. The email cannot script (the frame
 * is sandboxed without `allow-scripts`), so the policy is about what it may
 * fetch: images only from this server's attachment routes, from the image
 * proxy when remote images are allowed, and inline `data:`/`blob:`. No
 * stylesheets, fonts, media, frames or form posts reach the sender.
 *
 * `origin` is spelled out rather than `'self'` because a path-restricted
 * source needs a host, and path restriction is what keeps the proxy out of
 * the policy entirely while remote images are blocked.
 */
export function emailFrameCsp(origin: string, allowRemote: boolean): string {
	let parsed: URL;
	try {
		parsed = new URL(origin);
	} catch {
		throw new Error('emailFrameCsp: invalid origin');
	}
	if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || parsed.origin !== origin) {
		throw new Error('emailFrameCsp: invalid origin');
	}
	const img = [`${origin}/api/email/`, ...(allowRemote ? [`${origin}${IMAGE_PROXY_PATH}`] : []), 'data:', 'blob:'];
	return [
		"default-src 'none'",
		`img-src ${img.join(' ')}`,
		"style-src 'unsafe-inline'",
		'font-src data:',
		"media-src 'none'",
		"frame-src 'none'",
		"object-src 'none'",
		"form-action 'none'",
		"base-uri 'none'"
	].join('; ');
}
