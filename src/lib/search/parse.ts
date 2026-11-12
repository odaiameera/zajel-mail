/**
 * Token parser for the search input. Takes a raw string and returns a
 * flat list of tokens. Each token remembers its `raw` span so the UI can
 * reliably render it back as a pill at the right place in the input.
 */

import { isInboxCategory } from '$lib/types/categories';

export type FieldOp =
	| 'from'
	| 'to'
	| 'cc'
	| 'subject'
	| 'body'
	| 'in'
	| 'label'
	| 'before'
	| 'after'
	| 'tab';

export type FlagOp = 'is' | 'has';

export type Token =
	| { kind: 'field'; field: FieldOp; value: string; raw: string; start: number; end: number }
	| { kind: 'flag'; op: FlagOp; value: string; raw: string; start: number; end: number }
	| { kind: 'text'; value: string; raw: string; start: number; end: number }
	| { kind: 'error'; raw: string; reason: string; start: number; end: number };

const FIELD_OPS: FieldOp[] = [
	'from',
	'to',
	'cc',
	'subject',
	'body',
	'in',
	'label',
	'before',
	'after',
	'tab'
];
const FLAG_OPS: FlagOp[] = ['is', 'has'];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const IS_VALUES = new Set(['unread', 'read', 'starred']);
const HAS_VALUES = new Set(['attachment']);

interface RawChunk {
	raw: string;
	start: number;
	end: number;
}

/** Split the input on whitespace, respecting double-quoted spans. */
function splitChunks(input: string): RawChunk[] {
	const chunks: RawChunk[] = [];
	let i = 0;
	const len = input.length;
	while (i < len) {
		while (i < len && /\s/.test(input[i]!)) i++;
		if (i >= len) break;
		const start = i;
		let inQuote = false;
		while (i < len) {
			const ch = input[i]!;
			if (ch === '"') {
				inQuote = !inQuote;
				i++;
				continue;
			}
			if (!inQuote && /\s/.test(ch)) break;
			i++;
		}
		chunks.push({ raw: input.slice(start, i), start, end: i });
	}
	return chunks;
}

/** Strip one pair of surrounding double quotes from a value, if present. */
function unquote(value: string): { value: string; closed: boolean } {
	if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
		return { value: value.slice(1, -1), closed: true };
	}
	if (value.startsWith('"')) {
		return { value: value.slice(1), closed: false };
	}
	return { value, closed: true };
}

function classifyChunk(chunk: RawChunk): Token {
	const { raw, start, end } = chunk;
	const colon = raw.indexOf(':');

	if (colon === -1) {
		return { kind: 'text', value: raw, raw, start, end };
	}

	const fieldPart = raw.slice(0, colon).toLowerCase();
	const valuePart = raw.slice(colon + 1);

	if ((FLAG_OPS as readonly string[]).includes(fieldPart)) {
		const op = fieldPart as FlagOp;
		const v = valuePart.toLowerCase();
		if (!v) return { kind: 'error', raw, reason: 'empty value', start, end };
		if (op === 'is' && !IS_VALUES.has(v)) {
			return { kind: 'error', raw, reason: `unknown is: value "${v}"`, start, end };
		}
		if (op === 'has' && !HAS_VALUES.has(v)) {
			return { kind: 'error', raw, reason: `unknown has: value "${v}"`, start, end };
		}
		return { kind: 'flag', op, value: v, raw, start, end };
	}

	if ((FIELD_OPS as readonly string[]).includes(fieldPart)) {
		const field = fieldPart as FieldOp;
		const { value, closed } = unquote(valuePart);
		if (!closed) {
			return { kind: 'error', raw, reason: 'unclosed quote', start, end };
		}
		if (!value) {
			return { kind: 'error', raw, reason: 'empty value', start, end };
		}
		if ((field === 'before' || field === 'after') && !DATE_RE.test(value)) {
			return { kind: 'error', raw, reason: 'invalid date', start, end };
		}
		if (field === 'tab') {
			const tab = value.toLowerCase();
			if (!isInboxCategory(tab)) return { kind: 'error', raw, reason: `unknown tab: value "${tab}"`, start, end };
			return { kind: 'field', field, value: tab, raw, start, end };
		}
		return {
			kind: 'field',
			field,
			value,
			raw,
			start,
			end
		};
	}

	// Not a recognized operator — treat whole chunk as bare text, unquoting
	// a surrounding pair if present so `"foo bar"` becomes one text token.
	const { value, closed } = unquote(raw);
	if (!closed) {
		return { kind: 'text', value: raw, raw, start, end };
	}
	return { kind: 'text', value, raw, start, end };
}

export function parseSearch(input: string): Token[] {
	if (!input) return [];
	return splitChunks(input).map(classifyChunk);
}
