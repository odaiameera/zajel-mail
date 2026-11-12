import sanitizeHtml from 'sanitize-html';
import type { Email } from '$lib/jmap/types';
import { renderEmailBodyHtml } from '$lib/utils/email-body';
import { replyQuoteHtml } from '$lib/utils/reply-quote';
import { emailBodyText } from './email-text';

/**
 * The original message under one of the agent's replies, the way the app's
 * own Reply quotes it. The app's composer cleans what it loads; the agent's
 * draft goes straight to the mail server, so the sender's HTML is cleaned
 * here instead: structure, links and images stay, scripts, forms, styles and
 * event handlers go.
 */

/** Past this a message's HTML (a newsletter can be megabytes) is quoted as its text. */
const MAX_HTML = 200_000;
const MAX_TEXT = 50_000;

const QUOTE_OPTIONS: sanitizeHtml.IOptions = {
	allowedTags: [
		'p', 'br', 'div', 'span', 'strong', 'b', 'em', 'i', 'u', 's', 'strike', 'sub', 'sup', 'a',
		'ul', 'ol', 'li', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'code', 'hr',
		'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'img'
	],
	allowedAttributes: {
		// A dir the browser doesn't know is simply ignored, so any value may stay.
		'*': ['dir', 'style'],
		a: ['href'],
		img: ['src', 'alt', 'width', 'height'],
		td: ['colspan', 'rowspan'],
		th: ['colspan', 'rowspan']
	},
	// Only what lays the text out: an Arabic message keeps its direction.
	allowedStyles: {
		'*': {
			'text-align': [/^(left|right|center|justify|start|end)$/],
			direction: [/^(ltr|rtl)$/],
			'white-space': [/^(pre-wrap|pre-line|normal)$/]
		}
	},
	allowedSchemes: ['http', 'https', 'mailto'],
	allowedSchemesByTag: { img: ['http', 'https', 'data'] }
};

function escapeHtml(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The original's body, safe to put in a draft as it is. */
export function quotedBody(original: Email): string {
	const html = renderEmailBodyHtml(original);
	const clean = html && html.length <= MAX_HTML ? sanitizeHtml(html, QUOTE_OPTIONS).trim() : '';
	if (clean) return clean;
	const text = emailBodyText(original, MAX_TEXT);
	return text ? `<pre style="white-space: pre-wrap;">${escapeHtml(text)}</pre>` : '';
}

/** The quote block for a reply to `original`, dated on the user's clock; null when it names no sender. */
export function quoteOriginal(original: Email, timeZone: string): string | null {
	return replyQuoteHtml(original, quotedBody(original), timeZone) || null;
}
