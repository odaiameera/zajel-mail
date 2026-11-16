import DOMPurify from 'dompurify';
import { IMAGE_PROXY_PATH, proxiedImageUrl } from '$lib/utils/email-images';
import { QUOTE_ID } from '$lib/utils/reply-quote';
import { BLANK_LINE } from './text';

/**
 * A message body on its way into the editor and out of it.
 *
 * The editor (Rooster, see ./mail-editor) keeps the HTML it is given, which
 * is the point of it: a quoted message keeps its tables, colours and fonts.
 * The editor it replaced rebuilt everything into its own structure, and that
 * rebuilding was also the only thing standing between a sender's HTML and the
 * page. So what comes in is cleaned here, on purpose, before the editor sees
 * it; and what goes out is put back the way a mail client needs it.
 */

/**
 * Marks the signature block, so choosing another signature replaces it.
 * An id, as Outlook's own `id="Signature"`: the editor keeps ids and drops
 * classes. Older drafts carry `class="ameera-signature"`, read on the way in.
 */
export const SIGNATURE_ID = 'zajel-signature';
const LEGACY_SIGNATURE_CLASS = 'ameera-signature';

/** Marks the quoted original of a reply, or the forwarded message. */
export { QUOTE_ID };

/** Marks the wrapper the sent body is given, so it comes off again on the way in. */
const BODY_ATTR = 'data-zajel-body';

/** Line height of the editor and of the sent message (routes/layout.css says the same). */
export const LINE_HEIGHT = '1.5';

export { BLANK_LINE };

const ALLOWED_TAGS = [
	'a', 'abbr', 'b', 'bdi', 'bdo', 'big', 'blockquote', 'br', 'caption', 'center', 'cite', 'code', 'col',
	'colgroup', 'dd', 'del', 'div', 'dl', 'dt', 'em', 'font', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i',
	'img', 'ins', 'kbd', 'li', 'mark', 'ol', 'p', 'pre', 'q', 's', 'samp', 'small', 'span', 'strike', 'strong',
	'sub', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'tt', 'u', 'ul', 'var'
];

const ALLOWED_ATTR = [
	'href', 'src', 'alt', 'title', 'width', 'height', 'style', 'dir', 'lang', 'align', 'valign', 'bgcolor',
	'color', 'face', 'size', 'border', 'cellpadding', 'cellspacing', 'colspan', 'rowspan', 'start', 'type',
	'target', 'rel', 'id', 'role',
	// The editor's own notes on a list or a table (its style, its header row),
	// which it reads again when a draft is reopened.
	'data-editing-info'
];

// In a document of its own, which runs no script and loads no picture. A
// <div> holds it, not the <body>: the cleaner works in place, and only on a
// tag it allows.
function parse(html: string): HTMLElement {
	const root = new DOMParser().parseFromString('<body><div></div></body>', 'text/html').body.firstElementChild as HTMLElement;
	root.innerHTML = html;
	return root;
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

/**
 * Where the pictures in a message being quoted come from.
 * `cid`: the address each inline part can be shown from, by Content-ID.
 * `remote`: whether the reader let this message load pictures from the web
 * (Settings > Messages); if not, they stay unloaded here too.
 */
export interface ImageSources {
	cid?: Record<string, string>;
	remote?: boolean;
}

const CID_MARK = '#cid=';

/**
 * Point each picture at an address this page can load. The address it came
 * with stays readable from the new one, so {@link originalImages} needs no
 * memory of its own: a body can leave the editor, sit in the Undo toast, and
 * come back.
 */
function displayImages(root: HTMLElement, sources: ImageSources): void {
	for (const img of Array.from(root.querySelectorAll('img'))) {
		const src = img.getAttribute('src')?.trim() ?? '';
		if (/^cid:/i.test(src)) {
			const written = src.slice(4);
			let id = written.replace(/^<|>$/g, '');
			try {
				id = decodeURIComponent(id);
			} catch {
				// A stray percent sign: matched as written.
			}
			const url = sources.cid?.[id] ?? sources.cid?.[id.toLowerCase()];
			// The reference exactly as the sender wrote it rides along, to be
			// put back letter for letter: mail clients match it as text.
			if (url) img.setAttribute('src', `${url.split('#')[0]}${CID_MARK}${encodeURIComponent(written)}`);
		} else if (/^https?:\/\//i.test(src) && sources.remote) {
			img.setAttribute('src', proxiedImageUrl(src));
		}
		// Anything else is left as it is: a pasted picture (data:), one already
		// pointed here, or a remote one the reader chose not to load, which the
		// page's own policy then keeps from loading.
	}
}

/** Put each picture's own address back, for the message as sent. */
function originalImages(root: HTMLElement): void {
	for (const img of Array.from(root.querySelectorAll('img'))) {
		const src = img.getAttribute('src') ?? '';
		const cid = src.indexOf(CID_MARK);
		if (cid !== -1) {
			let written = src.slice(cid + CID_MARK.length);
			try {
				written = decodeURIComponent(written);
			} catch {
				// As it is.
			}
			img.setAttribute('src', `cid:${written}`);
			continue;
		}
		if (src.startsWith(`${IMAGE_PROXY_PATH}?`)) {
			const original = new URLSearchParams(src.slice(IMAGE_PROXY_PATH.length + 1)).get('url');
			if (original && /^https?:\/\//i.test(original)) img.setAttribute('src', original);
		}
	}
}

/** The Content-IDs a body draws, so only those parts are sent along as inline ones. */
export function inlineImageIds(html: string): Set<string> {
	const ids = new Set<string>();
	for (const img of Array.from(parse(html).querySelectorAll('img'))) {
		const src = img.getAttribute('src') ?? '';
		const at = src.indexOf(CID_MARK);
		let id = /^cid:/i.test(src) ? src.slice(4) : '';
		try {
			// Once for the trip in the address, once for the reference itself,
			// which is a Content-ID with URL escaping (RFC 2392).
			if (at !== -1) id = decodeURIComponent(src.slice(at + CID_MARK.length));
			id = decodeURIComponent(id.replace(/^<|>$/g, ''));
		} catch {
			// As written.
		}
		if (id) ids.add(id);
	}
	return ids;
}

// ---------------------------------------------------------------------------
// In: cleaning what the editor is given
// ---------------------------------------------------------------------------

export interface IncomingOptions {
	images?: ImageSources;
	/**
	 * A draft written in the editor this one replaced: one `<p>` per line,
	 * shown with no gap by that editor's own stylesheet. Each is given the
	 * margin it was written with, or it would open with a gap after every line.
	 */
	legacyParagraphs?: boolean;
}

// CSS that could take a quoted message out of the box it is quoted in, and
// over the app around it.
function tameStyle(element: HTMLElement): void {
	const style = element.style;
	if (!style) return;
	if (/fixed|absolute|sticky/i.test(style.position)) style.removeProperty('position');
	style.removeProperty('z-index');
	if (!element.getAttribute('style')?.trim()) element.removeAttribute('style');
}

/**
 * Take off the wrapper the last send or save put on (see {@link outgoingBody}),
 * so saving a draft again doesn't wrap it once more. The marked one, or, for
 * a draft from before there was a mark, a lone div that sets a font and a size.
 */
function unwrap(root: HTMLElement): void {
	const first = root.children[0] as HTMLElement | undefined;
	const alone = root.children.length === 1 && Array.from(root.childNodes).every((n) => n === first || !n.textContent?.trim());
	const only = alone ? first : null;
	if (!only || only.tagName !== 'DIV') return;
	const style = only.getAttribute('style') ?? '';
	const ours = only.hasAttribute(BODY_ATTR) || (!only.id && /^font-family:[^;]+;\s*font-size:[^;]+;?(\s*line-height:[^;]+;?)?\s*$/i.test(style));
	if (!ours) return;
	only.replaceWith(...Array.from(only.childNodes));
}

/**
 * Was this draft written in the old editor? Its wrapper set a font and a
 * size and nothing else; every later one also sets a line height.
 */
export function isLegacyDraft(html: string): boolean {
	return /^\s*<div style="font-family:[^";]+;\s*font-size:[^";]+;?">/i.test(html);
}

/**
 * Make a body safe and ready for the editor: a quoted message, a draft being
 * reopened, a send being undone.
 *
 *  - Only the tags and attributes mail is written with survive. No script,
 *    no stylesheet, no form, no frame, no event handler, no class.
 *  - No id but the editor's own two marks, and not even those inside the
 *    quoted message, which a sender wrote.
 *  - Pictures are pointed where this page can load them.
 */
export function incomingBody(html: string, options: IncomingOptions = {}): string {
	const root = parse(html);
	unwrap(root);

	// Before cleaning takes the class away.
	for (const old of Array.from(root.querySelectorAll(`div.${LEGACY_SIGNATURE_CLASS}`))) old.id = SIGNATURE_ID;

	DOMPurify.sanitize(root, {
		IN_PLACE: true,
		ALLOWED_TAGS,
		ALLOWED_ATTR,
		ALLOW_DATA_ATTR: false,
		ALLOW_ARIA_ATTR: false
	});

	const quote = root.querySelector(`#${QUOTE_ID}`);
	for (const element of Array.from(root.querySelectorAll<HTMLElement>('*'))) {
		tameStyle(element);
		if (!element.id) continue;
		const mark = element.id === SIGNATURE_ID || element.id === QUOTE_ID;
		const quoted = !!quote && element !== quote && quote.contains(element);
		if (!mark || quoted) element.removeAttribute('id');
	}
	// One of each: the first quote is the newest, and a signature below it
	// belongs to an older message.
	for (const id of [SIGNATURE_ID, QUOTE_ID]) {
		Array.from(root.querySelectorAll(`#${id}`)).slice(1).forEach((extra) => extra.removeAttribute('id'));
	}

	for (const a of Array.from(root.querySelectorAll('a[href]'))) {
		a.setAttribute('target', '_blank');
		a.setAttribute('rel', 'noopener noreferrer');
	}

	for (const p of Array.from(root.querySelectorAll('p'))) {
		const legacy = options.legacyParagraphs && !(quote && quote.contains(p));
		if (legacy && !/(^|;)\s*margin(-[a-z-]+)?\s*:/i.test(p.getAttribute('style') ?? '')) {
			const style = (p.getAttribute('style') ?? '').trim().replace(/;$/, '');
			p.setAttribute('style', `${style ? `${style}; ` : ''}margin: 0;`);
		}
		// An empty paragraph is a blank line someone typed; without something
		// in it, it has no height and the editor drops it.
		if (!p.firstChild) p.appendChild(root.ownerDocument.createElement('br'));
	}

	displayImages(root, options.images ?? {});
	return root.innerHTML;
}

// ---------------------------------------------------------------------------
// Out: the body as sent
// ---------------------------------------------------------------------------

/**
 * The body as sent or saved: the editor's HTML, wrapped in the account's font
 * and size and the editor's line height, so a reader whose mail client knows
 * none of this app's styles sees what the editor showed.
 */
export function outgoingBody(html: string, fontFamily: string, fontSize: string): string {
	const root = parse(html);
	originalImages(root);
	// The editor numbers the tables and pictures it has handles on
	// (`table_0`, `image_0`); those ids are its own business, not the reader's.
	for (const element of Array.from(root.querySelectorAll('[id]'))) {
		if (element.id !== SIGNATURE_ID && element.id !== QUOTE_ID) element.removeAttribute('id');
	}
	// The editor writes a direction as a style; mail clients are surer of the
	// attribute, and it is what a right-to-left reader's client looks for.
	for (const element of Array.from(root.querySelectorAll<HTMLElement>('[style*="direction"]'))) {
		const direction = element.style.direction;
		if (direction === 'rtl' || direction === 'ltr') element.setAttribute('dir', direction);
	}
	return `<div ${BODY_ATTR} style="font-family: ${fontFamily}; font-size: ${fontSize}; line-height: ${LINE_HEIGHT};">${root.innerHTML}</div>`;
}

// ---------------------------------------------------------------------------
// The signature and the quoted message
// ---------------------------------------------------------------------------

function isBlankLine(node: Element | null): node is HTMLElement {
	if (!node || !/^(DIV|P)$/.test(node.tagName) || node.id) return false;
	return !node.textContent?.trim() && !node.querySelector('img, hr, table');
}

/**
 * A stored signature, as lines for a message. Signatures written in the old
 * editor are `<p>` per line; here a line is a `<div>`, which has no gap of
 * its own in any mail client.
 */
export function signatureLines(html: string): string {
	return html
		.replace(/<p\b([^>]*)>\s*<\/p>/gi, '<div$1><br></div>')
		.replace(/<p\b/gi, '<div')
		.replace(/<\/p>/gi, '</div>');
}

/** The quoted original or forwarded message in a body, if it has one. */
function quoteOf(root: HTMLElement): HTMLElement | null {
	return root.querySelector<HTMLElement>(`#${QUOTE_ID}`);
}

/** This message's own signature: the marked block that isn't part of what is quoted. */
function signatureOf(root: HTMLElement): HTMLElement | null {
	const quote = quoteOf(root);
	return (
		Array.from(root.querySelectorAll<HTMLElement>(`#${SIGNATURE_ID}`)).find((s) => !quote?.contains(s)) ?? null
	);
}

/**
 * Put `signatureHtml` in the body as its signature, in place of the one
 * there; or take the signature out, for null.
 *
 * It goes under what is being written: at the end of a new message, and in
 * a reply or a forward above the quoted message, not below it, where nobody
 * reading the reply would look. A blank line sits above it to write in.
 */
export function applySignature(bodyHtml: string, signatureHtml: string | null): string {
	const root = parse(bodyHtml);
	const existing = signatureOf(root);
	if (existing) {
		// The line this put between it and the quoted message goes with it.
		const below = existing.nextElementSibling;
		if (isBlankLine(below) && below.nextElementSibling === quoteOf(root)) below.remove();
		existing.remove();
	}
	if (signatureHtml === null) return root.innerHTML;

	const doc = root.ownerDocument;
	const block = doc.createElement('div');
	block.id = SIGNATURE_ID;
	block.innerHTML = signatureLines(signatureHtml);
	const blank = () => {
		const line = doc.createElement('div');
		line.appendChild(doc.createElement('br'));
		return line;
	};

	// Before the quoted message when there is one, else at the end.
	const quote = quoteOf(root);
	const at = quote && quote.parentElement === root ? quote : null;
	// Room above it: a line to write on and one of space when nothing has
	// been written yet, a single line of space after text.
	let blanks = 0;
	let above = at ? at.previousElementSibling : root.lastElementChild;
	while (isBlankLine(above)) {
		blanks++;
		above = above.previousElementSibling;
	}
	for (const needed = above ? 1 : 2; blanks < needed; blanks++) root.insertBefore(blank(), at);
	root.insertBefore(block, at);
	if (at) root.insertBefore(blank(), at);
	return root.innerHTML;
}

/**
 * Whether anything has been written: text, a picture or a table outside the
 * signature and the quoted message. A new message holding only its
 * signature isn't worth keeping as a draft.
 */
export function hasWrittenContent(html: string): boolean {
	const root = parse(html);
	signatureOf(root)?.remove();
	quoteOf(root)?.remove();
	return !!root.textContent?.trim() || !!root.querySelector('img, table, hr');
}

/** Text length of a body, for the signature editor's counter. */
export function textLength(html: string): number {
	return parse(html).textContent?.length ?? 0;
}
