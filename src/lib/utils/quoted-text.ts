/**
 * Finding, in a reply, the earlier messages it quotes.
 *
 * In a conversation every message is on the page already, so the copy of
 * the thread that each reply carries underneath is hidden behind "•••" until
 * asked for, as Gmail's "Show trimmed content" does. A reply's own words are
 * what is left.
 *
 * There is no standard mark for a quote. This knows the ones mail clients
 * write (this app's, Gmail's, Outlook's, Apple Mail's, Thunderbird's,
 * Yahoo's, Proton's) and a plain <blockquote>. It errs towards showing: a
 * message that is nothing but its quote, or a forward, is left whole.
 */

/** Where a client starts the quoted message. First in the document wins. */
const QUOTE_SELECTORS = [
	'#zajel-quote',
	'.gmail_quote_container',
	'.gmail_quote',
	'.gmail_extra',
	'#divRplyFwdMsg',
	'#appendonsend',
	'.OutlookMessageHeader',
	'.moz-cite-prefix',
	'blockquote[type="cite"]',
	'.yahoo_quoted',
	'.protonmail_quote',
	'#isForwardContent',
	'blockquote'
].join(',');

/** "On Mon, 16 Nov 2026 at 10:00, Dana wrote:" and its like, on a line of its own above the quote. */
const ATTRIBUTION =
	/^\s*(on\b.{5,300}\bwrote|le\b.{5,300}\ba écrit|am\b.{5,300}\bschrieb.{0,60}|el\b.{5,300}\bescribió|il\b.{5,300}\bha scritto|في\b.{5,300}\bكتب.{0,60}|.{5,300}\bwrote)\s*:?\s*$/isu;

/** A quote that is the message itself: a forward. */
const FORWARDED = /^\s*(-{2,}\s*)?(forwarded message|original message|begin forwarded message)/i;

/** Outlook on the desktop marks nothing: a ruled-off block that starts "From:". */
function outlookHeader(root: HTMLElement): Element | null {
	for (const div of Array.from(root.querySelectorAll('div[style*="border-top"], div[style*="BORDER-TOP"]'))) {
		if (/^\s*(from|von|de|da|من)\s*:/i.test(div.textContent ?? '')) return div;
	}
	return null;
}

function hasContent(node: Node): boolean {
	if (node.nodeType === Node.TEXT_NODE) return !!node.textContent?.trim();
	if (node.nodeType !== Node.ELEMENT_NODE) return false;
	const element = node as Element;
	return !!element.textContent?.trim() || !!element.querySelector('img, table, hr') || /^(IMG|TABLE)$/.test(element.tagName);
}

export interface SplitMessage {
	/** The message without what it quotes; the whole message when nothing was trimmed. */
	main: string;
	/** Whether something was trimmed, and so there is more to show. */
	trimmed: boolean;
}

/**
 * Split a message's HTML into its own words and the quote under them.
 * Everything from the start of the quote on is trimmed, wherever the quote
 * sits in the markup.
 */
export function splitQuoted(html: string): SplitMessage {
	const whole = { main: html, trimmed: false };
	if (!html || typeof DOMParser === 'undefined') return whole;
	const doc = new DOMParser().parseFromString(html, 'text/html');
	const root = doc.body;

	const marked = root.querySelector(QUOTE_SELECTORS);
	const ruled = outlookHeader(root);
	// Whichever comes first in the message.
	const start =
		marked && ruled
			? marked.compareDocumentPosition(ruled) & Node.DOCUMENT_POSITION_FOLLOWING
				? marked
				: ruled
			: (marked ?? ruled);
	if (!start) return whole;
	if (FORWARDED.test(start.textContent ?? '')) return whole;

	// Take out the quote and everything after it, at each level up to the top.
	let cut: Node = start;
	// The line that introduces it goes too ("On … wrote:"), and the rule
	// Outlook draws above its header.
	for (let prev = start.previousSibling; prev; prev = prev.previousSibling) {
		if (prev.nodeType === Node.TEXT_NODE && !prev.textContent?.trim()) continue;
		const isRule = prev.nodeType === Node.ELEMENT_NODE && (prev as Element).tagName === 'HR';
		const text = prev.textContent ?? '';
		if (isRule || (text.length < 400 && ATTRIBUTION.test(text))) cut = prev;
		break;
	}
	for (let node: Node | null = cut; node && node !== root; ) {
		const parent: Node | null = node.parentNode;
		while (node.nextSibling) node.nextSibling.remove();
		if (node === cut) parent?.removeChild(node);
		// Blank lines left hanging where the quote was, at this level.
		for (let last = parent?.lastChild; parent && parent !== root && last && !hasContent(last); last = parent.lastChild) last.remove();
		node = parent;
	}

	// Nothing of the sender's own left: the quote was the message.
	if (!Array.from(root.childNodes).some(hasContent)) return whole;
	for (let last = root.lastChild; last && !hasContent(last); last = root.lastChild) last.remove();
	return { main: root.innerHTML, trimmed: true };
}
