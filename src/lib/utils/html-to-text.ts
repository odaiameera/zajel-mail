/**
 * Plain-text rendering of the composer's HTML, sent as the text/plain half
 * of a multipart/alternative message. HTML-only mail scores worse with spam
 * filters and is unreadable in text-only clients and notification previews.
 *
 * Deliberately small and DOM-free (it runs on the server): paragraphs and
 * line breaks become newlines, list items get bullets, links keep their URL,
 * and quoted replies (<blockquote>) get the usual "> " prefix per level.
 */

const QUOTE_OPEN = '\u0001';
const QUOTE_CLOSE = '\u0002';

const ENTITIES: Record<string, string> = {
	nbsp: ' ',
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
	'#39': "'"
};

function decodeEntities(text: string): string {
	return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (match, name: string) => {
		const lower = name.toLowerCase();
		if (lower.startsWith('#x')) return String.fromCodePoint(parseInt(lower.slice(2), 16));
		if (lower.startsWith('#')) return String.fromCodePoint(parseInt(lower.slice(1), 10));
		return ENTITIES[lower] ?? match;
	});
}

export function htmlToText(html: string): string {
	let s = html
		.replace(/\r\n?/g, '\n')
		.replace(/<(head|style|script)\b[\s\S]*?<\/\1>/gi, '')
		.replace(/<!--[\s\S]*?-->/g, '')
		// Source newlines are formatting, not content; only tags break lines.
		.replace(/\n/g, ' ')
		.replace(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, inner: string) => {
			const text = inner.replace(/<[^>]+>/g, '').trim();
			const url = href.replace(/^mailto:/i, '');
			return !text || decodeEntities(text) === decodeEntities(url) ? url : `${text} (${url})`;
		})
		// The composer's paragraphs are lines: it sends them with no margin,
		// and a blank line as a paragraph holding a <br> (see compose-html).
		// As lines here too, or the text half would put a blank line after
		// every line written. Any other <p> is a paragraph, with a gap.
		.replace(
			/<p\b[^>]*\bstyle\s*=\s*"[^"]*\bmargin\s*:\s*0(?![\d.])[^"]*"[^>]*>([\s\S]*?)<\/p>/gi,
			(_m, inner: string) => (/^\s*<br\s*\/?>\s*$/i.test(inner) ? '<br><br>' : `${inner}<br>`)
		)
		.replace(/<blockquote\b[^>]*>/gi, `\n${QUOTE_OPEN}`)
		.replace(/<\/blockquote>/gi, `${QUOTE_CLOSE}\n`)
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<li\b[^>]*>/gi, '\n• ')
		.replace(/<\/(p|div|h[1-6]|tr|ul|ol|table|pre)>/gi, '\n')
		.replace(/<(p|div|h[1-6]|tr|ul|ol|table|pre)\b[^>]*>/gi, '\n')
		.replace(/<\/t[dh]>/gi, '\t')
		.replace(/<[^>]+>/g, '');
	s = decodeEntities(s);

	// Walk the text once, tracking quote depth from the markers.
	let entries: { depth: number; text: string }[] = [];
	let depth = 0;
	for (const raw of s.split('\n')) {
		let text = '';
		for (const ch of raw) {
			if (ch === QUOTE_OPEN) depth++;
			else if (ch === QUOTE_CLOSE) depth = Math.max(0, depth - 1);
			else text += ch;
		}
		entries.push({ depth, text: text.replace(/[ \t]+/g, ' ').trim() });
	}
	// Blank lines just inside a quote's opening or closing are artefacts of
	// the markup, not spacing anyone wrote: drop them, then collapse runs.
	entries = entries.filter((e, i) => e.text || i === 0 || e.depth <= entries[i - 1].depth);
	entries = entries.filter((e, i) => e.text || i === entries.length - 1 || e.depth <= entries[i + 1].depth);
	entries = entries.filter((e, i) => e.text || i === 0 || entries[i - 1].text);
	return entries
		.map((e) => (e.depth > 0 ? ('> '.repeat(e.depth) + e.text).trimEnd() : e.text))
		.join('\n')
		.trim();
}
