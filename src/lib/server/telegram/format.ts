import { Lexer, type Token, type Tokens } from 'marked';
import { escapeHtml } from './bot';

/**
 * The agent writes Markdown, and Telegram shows it raw: its HTML mode takes
 * only a few tags (b, i, s, code, pre, blockquote, a) and has no lists,
 * headings or paragraphs. This turns a reply into that HTML, and cuts a long
 * one into messages Telegram will take, at paragraph and list-item breaks.
 *
 * Model output is untrusted: it is shaped by mail, so nothing in it passes
 * through as HTML. Raw tags come out as text, and a link shows where it goes,
 * `words (https://…)`, instead of hiding the address behind its words.
 */

/** A paragraph, a list item, a code block: never split unless it alone is too long. */
export interface Piece {
	html: string;
	/** Joined to the one before by a line break rather than a blank line (list items, table rows). */
	tight: boolean;
}

/**
 * Telegram refuses a message whose text is over 4096 characters. Packing to
 * this leaves room for the note on a report that ran out of messages.
 */
export const MESSAGE_LIMIT = 4000;
/** A report longer than this many messages is cut: past that it is a flood, not a report. */
export const MAX_MESSAGES = 5;
const CUT_NOTE = '\n\n<i>…cut here: the rest is too long for Telegram.</i>';

const wrap = (tag: string, html: string) => (html ? `<${tag}>${html}</${tag}>` : '');

function inline(tokens: Token[] | undefined): string {
	return (tokens ?? []).map(inlineToken).join('');
}

function inlineToken(token: Token): string {
	switch (token.type) {
		case 'strong':
			return wrap('b', inline(token.tokens));
		case 'em':
			return wrap('i', inline(token.tokens));
		case 'del':
			return wrap('s', inline(token.tokens));
		case 'codespan':
			return wrap('code', escapeHtml(token.text));
		case 'br':
			return '\n';
		case 'link':
			return link(token as Tokens.Link);
		case 'image':
			// Alt text only: Telegram wouldn't show it inline anyway.
			return escapeHtml(token.text ?? '');
		case 'text':
			return token.tokens?.length ? inline(token.tokens) : escapeHtml(token.text);
		case 'escape':
			return escapeHtml(token.text);
		default:
			// Inline HTML, and anything else: shown as written.
			return escapeHtml(token.raw ?? '');
	}
}

function link(token: Tokens.Link): string {
	const words = inline(token.tokens);
	const address = token.href.replace(/^mailto:/i, '');
	// A bare URL or address the parser picked up: it is its own text.
	if (!address || token.text === token.href || token.text === address) return words || escapeHtml(address);
	return `${words} (${escapeHtml(address)})`;
}

function joinPieces(pieces: Piece[]): string {
	return pieces
		.filter((p) => p.html)
		.map((p, i) => (i === 0 ? '' : p.tight ? '\n' : '\n\n') + p.html)
		.join('');
}

function listLines(list: Tokens.List, depth: number, quoted: boolean): string[] {
	const indent = '   '.repeat(depth);
	const start = typeof list.start === 'number' ? list.start : 1;
	return list.items.flatMap((item, i) => {
		const marker = list.ordered ? `${start + i}.` : '•';
		const box = item.task ? (item.checked ? '☑ ' : '☐ ') : '';
		const text: Piece[] = [];
		const nested: string[] = [];
		for (const child of item.tokens) {
			if (child.type === 'list') nested.push(...listLines(child as Tokens.List, depth + 1, quoted));
			else if (child.type !== 'checkbox') text.push(...block(child, quoted));
		}
		return [`${indent}${marker} ${box}${joinPieces(text)}`, ...nested];
	});
}

function block(token: Token, quoted: boolean): Piece[] {
	const piece = (html: string, tight = false): Piece[] => (html ? [{ html, tight }] : []);
	switch (token.type) {
		case 'space':
		case 'def':
			return [];
		case 'paragraph':
			return piece(inline(token.tokens));
		case 'text':
			return piece(token.tokens?.length ? inline(token.tokens) : escapeHtml(token.text));
		case 'heading':
			return piece(wrap('b', inline(token.tokens)));
		case 'code':
			return piece(wrap('pre', escapeHtml(token.text)));
		case 'hr':
			return piece('──────────');
		case 'blockquote': {
			// Telegram doesn't nest quotes, so a quote in a quote is just text.
			const inner = joinPieces((token.tokens ?? []).flatMap((t) => block(t, true)));
			return piece(quoted ? inner : wrap('blockquote', inner));
		}
		case 'list':
			// One piece per item, its sub-items with it, so a long list splits between items.
			return listLines(token as Tokens.List, 0, quoted).map((html, i) => ({ html, tight: i > 0 }));
		case 'table': {
			const table = token as Tokens.Table;
			const row = (cells: Tokens.TableCell[]) => cells.map((c) => inline(c.tokens)).join(' | ');
			return [...piece(wrap('b', row(table.header))), ...table.rows.map((r) => ({ html: row(r), tight: true }))];
		}
		default:
			// Block HTML, and anything else: shown as written.
			return piece(escapeHtml((token.raw ?? '').trim()));
	}
}

/** A Markdown reply as Telegram HTML, one piece per block. */
export function markdownPieces(markdown: string): Piece[] {
	if (!markdown?.trim()) return [];
	return Lexer.lex(markdown, { gfm: true }).flatMap((token) => block(token, false));
}

/** A Markdown reply as one piece of Telegram HTML, for text that is always short (a reminder). */
export function markdownToTelegram(markdown: string): string {
	return joinPieces(markdownPieces(markdown));
}

/** Plain text as a piece: what a tool or a sender wrote, which isn't Markdown. */
export function plainPiece(text: string, tight = false): Piece {
	return { html: escapeHtml(text), tight };
}

/** What Telegram counts: the text once tags are gone, an entity as one character. */
export function visibleLength(html: string): number {
	return html.replace(/<[^>]*>/g, '').replace(/&(?:amp|lt|gt|quot);/g, '_').length;
}

function unescapeHtml(text: string): string {
	return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

/**
 * A piece too long for one message, cut at line breaks where it can be. Its
 * tags may span those breaks, so the parts go as plain text: a paragraph of
 * thousands of characters loses its bold, not its words.
 */
function splitPiece(piece: Piece, room: number): Piece[] {
	if (visibleLength(piece.html) <= room) return [piece];
	const text = unescapeHtml(piece.html.replace(/<[^>]*>/g, ''));
	const parts: Piece[] = [];
	let rest = text;
	while (rest.length > room) {
		const at = rest.lastIndexOf('\n', room);
		const cut = at > room / 2 ? at : room;
		parts.push(plainPiece(rest.slice(0, cut), parts.length > 0 || piece.tight));
		rest = rest.slice(cut).replace(/^\n/, '');
	}
	if (rest) parts.push(plainPiece(rest, true));
	return parts;
}

/**
 * Messages for Telegram: `head` (a bold title) and the pieces, packed in
 * order so that no message is over Telegram's limit. A report that would take
 * more than MAX_MESSAGES is cut, and says so.
 */
export function packMessages(head: string, pieces: Piece[], limit = MESSAGE_LIMIT, max = MAX_MESSAGES): string[] {
	const messages: string[] = [];
	let current = head;
	// Only the title so far: the first piece sits right under it.
	let underHead = !!head;
	for (const piece of pieces.filter((p) => p.html).flatMap((p) => splitPiece(p, limit - visibleLength(head) - 1))) {
		const sep = !current ? '' : underHead || piece.tight ? '\n' : '\n\n';
		if (current && visibleLength(current + sep + piece.html) > limit) {
			messages.push(current);
			current = piece.html;
		} else {
			current += sep + piece.html;
		}
		underHead = false;
	}
	if (current) messages.push(current);
	if (messages.length <= max) return messages;
	const kept = messages.slice(0, max);
	kept[max - 1] += CUT_NOTE;
	return kept;
}
