import sanitizeHtml from 'sanitize-html';

/**
 * Allowlist for signature HTML. Intentionally small: lines (a `<div>` each,
 * as the editor writes them; `<p>` for signatures saved by the editor before
 * it), line breaks, links, basic emphasis, and a font, a size and a direction
 * as inline styles. Anything outside the list is stripped, including other
 * inline styles, scripts and event handlers, so the saved HTML is safe to put
 * straight into a message.
 */
const direction = (tagName: string, attribs: sanitizeHtml.Attributes) => {
	// A direction, and only the two there are.
	const dir = attribs.dir?.trim().toLowerCase();
	const kept: sanitizeHtml.Attributes = dir === 'rtl' || dir === 'ltr' ? { dir } : {};
	if (attribs.style !== undefined) kept.style = attribs.style;
	return { tagName, attribs: kept };
};

const SIGNATURE_OPTIONS: sanitizeHtml.IOptions = {
	allowedTags: ['div', 'p', 'br', 'a', 'strong', 'b', 'em', 'i', 'u', 'span'],
	allowedAttributes: {
		a: ['href', 'target', 'rel'],
		p: ['dir'],
		div: ['dir', 'style'],
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
			'font-size': [/^\d+(\.\d+)?(pt|px)$/],
			// The editor writes a line's direction and alignment as styles.
			direction: [/^(rtl|ltr)$/],
			'text-align': [/^(left|right|center|start|end)$/]
		}
	},
	transformTags: {
		// Force-safe link attributes regardless of what came in.
		a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer', target: '_blank' }),
		p: direction,
		div: direction
	}
};

export function sanitizeSignatureHtml(input: string): string {
	return sanitizeHtml(input, SIGNATURE_OPTIONS);
}
