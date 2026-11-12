import sanitizeHtml from 'sanitize-html';

/**
 * Allowlist for signature HTML. Intentionally tiny: paragraphs (with a
 * `dir` of rtl or ltr, for an Arabic signature), line breaks, links, basic
 * emphasis, and `<span style="font-family: …;
 * font-size: …">` (Tiptap's TextStyle output). Anything outside the
 * list is stripped — including arbitrary inline styles, scripts, and
 * event handlers — so the saved HTML is safe to inject directly into a
 * Tiptap doc or an outgoing message body.
 */
const SIGNATURE_OPTIONS: sanitizeHtml.IOptions = {
	allowedTags: ['p', 'br', 'a', 'strong', 'b', 'em', 'i', 'span'],
	allowedAttributes: {
		a: ['href', 'target', 'rel'],
		p: ['dir'],
		span: ['style']
	},
	allowedSchemes: ['http', 'https', 'mailto'],
	allowedSchemesAppliedToAttributes: ['href'],
	allowedStyles: {
		'*': {
			// Names: letters, digits, spaces, commas, single/double quotes, hyphens.
			// Covers things like:  'Helvetica Neue', Cairo, Calibri, sans-serif
			'font-family': [/^[\w\s,'"&-]+$/],
			// Sizes: numeric pt or px values only.
			'font-size': [/^\d+(\.\d+)?(pt|px)$/]
		}
	},
	transformTags: {
		// Force-safe link attributes regardless of what came in.
		a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer', target: '_blank' }),
		// A direction, and only the two there are.
		p: (tagName, attribs) => {
			const dir = attribs.dir?.trim().toLowerCase();
			const kept: sanitizeHtml.Attributes = dir === 'rtl' || dir === 'ltr' ? { dir } : {};
			return { tagName, attribs: kept };
		}
	}
};

export function sanitizeSignatureHtml(input: string): string {
	return sanitizeHtml(input, SIGNATURE_OPTIONS);
}
