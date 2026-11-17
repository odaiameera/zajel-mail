import type { ComposeAttachment, EmailAddress } from '$lib/jmap/types';

/**
 * Parsing for what the composer posts to /api/send and /api/draft. Both
 * endpoints take the same shape, so they share one place that decides what
 * a client value is allowed to be.
 */

export type Importance = 'high' | 'normal' | 'low';

export function parseAddresses(input: unknown): EmailAddress[] {
	if (typeof input !== 'string' || !input.trim()) return [];
	return input
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean)
		.map((email) => ({ name: null, email }));
}

/** Coerce the client-supplied attachment list into trusted blob references. */
export function parseAttachments(input: unknown): ComposeAttachment[] {
	if (!Array.isArray(input)) return [];
	return input
		.filter((a): a is ComposeAttachment => !!a && typeof a.blobId === 'string')
		.map((a) => ({
			blobId: a.blobId,
			name: typeof a.name === 'string' ? a.name : 'attachment',
			type: typeof a.type === 'string' ? a.type : 'application/octet-stream',
			size: typeof a.size === 'number' ? a.size : 0,
			// A Content-ID is a header value: nothing that could end the line.
			...(typeof a.cid === 'string' && /^[^\s<>]{1,255}$/.test(a.cid) && { cid: a.cid })
		}));
}

export function parseImportance(input: unknown): Importance {
	return input === 'high' || input === 'low' ? input : 'normal';
}

/**
 * A Message-ID-style value for In-Reply-To / References: angle brackets
 * stripped (JMAP wants the bare id), whitespace-separated for References,
 * anything that isn't a plausible id dropped.
 */
export function parseMessageIds(input: unknown): string[] {
	if (typeof input !== 'string') return [];
	return input
		.split(/\s+/)
		.map((id) => id.replace(/^<|>$/g, '').trim())
		.filter((id) => id.length > 0 && id.length <= 998 && id.includes('@'));
}

/** A JMAP id the client says is an existing draft, or undefined. */
export function parseDraftId(input: unknown): string | undefined {
	return typeof input === 'string' && /^[A-Za-z0-9_-]{1,255}$/.test(input) ? input : undefined;
}

/** The furthest ahead a message can be scheduled. */
export const MAX_SCHEDULE_AHEAD_MS = 366 * 24 * 60 * 60 * 1000;

/**
 * When the client asked for the message to go out: a future time within
 * a year, or null for "now". `invalid` when it named a time that won't do.
 */
export function parseSendAt(input: unknown, now = Date.now()): Date | null | 'invalid' {
	if (input === undefined || input === null || input === '') return null;
	if (typeof input !== 'string') return 'invalid';
	const at = new Date(input);
	const t = at.getTime();
	if (Number.isNaN(t) || t <= now || t > now + MAX_SCHEDULE_AHEAD_MS) return 'invalid';
	return at;
}

/** The Undo send choices, in seconds; 0 is off. */
export const UNDO_SEND_CHOICES = [0, 5, 10, 20, 30] as const;
export const DEFAULT_UNDO_SEND_SECONDS = 10;

/** The stored Undo send preference, or the default when unset or unknown. */
export function parseUndoSendSeconds(input: unknown): number {
	const n = typeof input === 'string' && input.trim() !== '' ? Number(input) : typeof input === 'number' ? input : NaN;
	return (UNDO_SEND_CHOICES as readonly number[]).includes(n) ? n : DEFAULT_UNDO_SEND_SECONDS;
}
