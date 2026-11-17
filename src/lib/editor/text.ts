/**
 * Plain text as lines for the message editor. No dependencies, so the server
 * can use it too.
 */

/** An empty line: what the editor starts a new message with. */
export const BLANK_LINE = '<div><br></div>';

function escapeHtml(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Text as the editor writes it: a `<div>` per line and an empty one for a
 * blank line, escaped, so nothing in it is read as markup. A `<div>` has no
 * gap of its own in any mail client, so the text arrives spaced as written.
 */
export function textToLines(text: string): string {
	if (!text) return '';
	return text
		.replace(/\r\n?/g, '\n')
		.split('\n')
		.map((line) => (line.trim() ? `<div>${escapeHtml(line)}</div>` : BLANK_LINE))
		.join('');
}
