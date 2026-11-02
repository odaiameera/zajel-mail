import type { Email } from '$lib/jmap/types';
import { htmlToText } from '$lib/utils/html-to-text';

/**
 * What gets embedded for a message: its subject as the title, and the sender
 * plus the start of its own text, split into a few chunks. Quoted replies are
 * dropped — they are the earlier messages, which are indexed in their own
 * right — so a long thread doesn't drown each reply in its history.
 */

/** Characters per chunk: well inside the context of any small embedding model. */
export const CHUNK_CHARS = 1000;
/**
 * Chunks per message; the rest of a long body goes unindexed. Embedding runs
 * at a few hundred tokens a second on a CPU, so this bounds the backfill:
 * a message's opening says most of what it is about.
 */
export const MAX_CHUNKS = 2;
/** Body bytes asked of the server — enough for the chunks after quotes are dropped. */
export const MAX_BODY_BYTES = 8_000;

/** Properties fetched for indexing. */
export const INDEX_PROPERTIES = [
	'id', 'mailboxIds', 'receivedAt', 'from', 'subject', 'preview',
	'textBody', 'htmlBody', 'bodyValues'
];

export interface EmailDocument {
	title: string;
	chunks: string[];
}

function who(email: Email): string {
	return (email.from ?? []).map((a) => (a.name ? `${a.name} <${a.email}>` : a.email)).join(', ');
}

/** The message's own text: its text/plain part, or its HTML as text. */
export function bodyText(email: Email): string {
	const values = email.bodyValues ?? {};
	const join = (parts: Email['textBody'], type: string) =>
		(parts ?? [])
			.filter((part) => part.type?.toLowerCase().startsWith(type))
			.map((part) => values[part.partId]?.value ?? '')
			.join('\n');
	const plain = join(email.textBody, 'text/plain');
	const text = plain.trim() ? plain : htmlToText(join(email.htmlBody, 'text/html'));
	return withoutQuotes(text.trim() ? text : (email.preview ?? ''));
}

/** Drop quoted lines and the "On … wrote:" line before them, then tidy whitespace. */
export function withoutQuotes(text: string): string {
	const lines = text.replace(/\r\n?/g, '\n').split('\n');
	const kept: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();
		if (line.startsWith('>')) continue;
		if (/wrote:$|كتب:$/.test(line) && (lines[i + 1] ?? '').trim().startsWith('>')) continue;
		kept.push(line);
	}
	return kept.join('\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

/** Split at whitespace near each CHUNK_CHARS boundary, at most MAX_CHUNKS pieces. */
export function chunkText(text: string): string[] {
	const chunks: string[] = [];
	let rest = text.trim();
	while (rest && chunks.length < MAX_CHUNKS) {
		if (rest.length <= CHUNK_CHARS) {
			chunks.push(rest);
			break;
		}
		const space = rest.lastIndexOf(' ', CHUNK_CHARS);
		const newline = rest.lastIndexOf('\n', CHUNK_CHARS);
		const cut = Math.max(space, newline) > CHUNK_CHARS / 2 ? Math.max(space, newline) : CHUNK_CHARS;
		chunks.push(rest.slice(0, cut).trim());
		rest = rest.slice(cut).trim();
	}
	return chunks;
}

/** A message's title and chunks. Every message has at least one chunk, if only its sender. */
export function emailDocument(email: Email): EmailDocument {
	const sender = who(email);
	const header = sender ? `From: ${sender}` : '';
	const body = chunkText(bodyText(email));
	const chunks = body.length ? body.map((chunk) => (header ? `${header}\n${chunk}` : chunk)) : [header || '(no text)'];
	return { title: (email.subject ?? '').trim(), chunks };
}
