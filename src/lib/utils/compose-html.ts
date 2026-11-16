/**
 * The composer's HTML, on its way out and on its way back in.
 *
 * The editor (Tiptap) writes one `<p>` per line and shows them the way a mail
 * composer is expected to: no gap between lines, a blank line where Enter was
 * pressed twice, line height 1.5. That look lived only in the app's own
 * stylesheet (routes/layout.css). The message was sent as bare `<p>` tags, so
 * a recipient's mail client put a paragraph gap after every line, and the
 * blank lines, being empty paragraphs, collapsed to nothing: tight lines came
 * out spaced, and spacing came out gone.
 *
 * So the message carries the look with it, as inline styles (mail clients
 * drop or rewrite stylesheets): the same rules as `.full-composer-editor` in
 * routes/layout.css. Keep the two in step.
 */

/** Line height of the editor and of the sent message. */
const LINE_HEIGHT = '1.5';

// Fixed colours: the editor's follow the theme, a sent message is read on
// white. The same greys the forwarded-message header uses.
const RULE = '#d1d9e0';
const MUTED = '#59636e';

/** Inline styles per element, mirroring the editor's stylesheet. */
const STYLES: Record<string, [string, string][]> = {
	p: [['margin', '0']],
	ul: [['margin', '0.25em 0'], ['padding-inline-start', '1.5em']],
	ol: [['margin', '0.25em 0'], ['padding-inline-start', '1.5em']],
	h1: [['font-size', '1.5em'], ['font-weight', '700'], ['margin', '0.5em 0']],
	h2: [['font-size', '1.25em'], ['font-weight', '600'], ['margin', '0.5em 0']],
	h3: [['font-size', '1.1em'], ['font-weight', '600'], ['margin', '0.5em 0']],
	blockquote: [
		['margin', '0'],
		['padding-inline-start', '1em'],
		['border-inline-start', `3px solid ${RULE}`],
		['color', MUTED]
	],
	table: [['border-collapse', 'collapse'], ['width', '100%'], ['margin', '0.5em 0']],
	td: [['border', `1px solid ${RULE}`], ['padding', '6px 10px']],
	th: [['border', `1px solid ${RULE}`], ['padding', '6px 10px'], ['background', '#f6f8fa'], ['font-weight', '600']],
	img: [['max-width', '100%'], ['height', 'auto']]
};

// A property the element already sets (a quoted message's own border, an
// alignment) is left as it is. `margin` also stands down for `margin-top`
// and the like, which it would otherwise reset.
function sets(style: string, property: string): boolean {
	return new RegExp(`(^|;)\\s*${property}(-[a-z-]+)?\\s*:`, 'i').test(style);
}

function withStyles(element: Element, styles: [string, string][]): void {
	let style = (element.getAttribute('style') ?? '').trim().replace(/;$/, '');
	for (const [property, value] of styles) {
		if (sets(style, property)) continue;
		style += `${style ? '; ' : ''}${property}: ${value}`;
	}
	if (style) element.setAttribute('style', `${style};`);
}

/**
 * The body as sent: what the editor showed, for a reader whose mail client
 * knows none of the app's styles. Wrapped in the account's font and size.
 */
export function outgoingBody(html: string, fontFamily: string, fontSize: string): string {
	const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
	for (const element of Array.from(doc.body.querySelectorAll(Object.keys(STYLES).join(',')))) {
		withStyles(element, STYLES[element.tagName.toLowerCase()]);
	}
	// A blank line. An empty paragraph has no height anywhere but in the
	// editor, which draws one itself.
	for (const p of Array.from(doc.body.querySelectorAll('p'))) {
		if (!p.firstChild) p.appendChild(doc.createElement('br'));
	}
	return `<div style="font-family: ${fontFamily}; font-size: ${fontSize}; line-height: ${LINE_HEIGHT};">${doc.body.innerHTML}</div>`;
}

/**
 * A body coming back into the editor: a draft reopened, a send undone. The
 * `<br>` that stood for a blank line goes, or the editor reads it as a line
 * break inside the paragraph and draws the blank line twice as tall. The
 * inline styles need nothing: the editor keeps only what its schema knows.
 */
export function editableBody(html: string): string {
	return html.replace(/<p\b([^>]*)>\s*<br\s*\/?>\s*<\/p>/gi, '<p$1></p>');
}
