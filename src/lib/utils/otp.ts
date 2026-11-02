import type { Email } from '$lib/jmap/types';

/**
 * Find the one-time sign-in code in a verification email ("Use the code
 * below to log in… 504072… This code expires in 15 minutes").
 *
 * Copying a detected code can also move the email to Trash, so a false
 * positive costs the user an email, not just a wrong clipboard. Detection is
 * therefore deliberately narrow:
 *  1. The email must read like a verification email at all — "verification",
 *     "one-time", "expires in 10 minutes", "didn't request this code"… A
 *     receipt or a newsletter with a zip code never gets that far.
 *  2. A candidate must sit close to the word "code" (or passcode, PIN, OTP…)
 *     and be a standalone number — not part of a phone number, date, price
 *     or order number.
 * The subject is checked first: "504072 is your verification code" is the
 * most reliable place a code appears.
 */

export interface DetectedCode {
	/** What to put on the clipboard — digits/letters only, no separators. */
	code: string;
	/** How the email wrote it ("123 456" stays grouped for reading). */
	display: string;
}

const CONTEXT = [
	/\bverif(?:y|ied|ying|ication)\b/i,
	// Not a bare "one-time", which is mostly "one-time offer".
	/\bone[-\s]?time\s+(?:pass(?:word|code)?|code|pin|log[-\s]?in|sign[-\s]?in|verification|security)\b/i,
	/\botp\b/i,
	/\bpass-?code\b/i,
	/\b(?:2fa|mfa)\b/i,
	/\b(?:two|2)[-\s]?(?:factor|step)\b/i,
	/\bmulti[-\s]?factor\b/i,
	// Not "confirmation code": on a booking that is the reservation number.
	/\b(?:security|login|log[-\s]?in|sign[-\s]?in|sign[-\s]?on|authentication|auth|access|reset|temporary)\s+code\b/i,
	/\bcode\s+(?:is\s+)?(?:valid|expires?|will\s+expire)\b/i,
	/\b(?:expires?|valid)\s+(?:in|for)\s+(?:the\s+next\s+)?\d+\s*(?:min(?:ute)?s?|hours?)\b/i,
	/\bdid(?:n['’]t|\s+not)\s+request\b/i
];

// Where a code is announced. `code` may end a compound ("Sicherheitscode").
const ANCHOR = /code\b|\b(?:passcode|pin|otp|token)\b|\bone[-\s]?time\s+pass(?:word)?\b/gi;

// 4–8 digits, optionally grouped once ("123 456", "1234-5678"), or single
// digits spaced out the way some templates render one digit per cell.
const NUMBER = /\d{3,4}[ -]\d{3,4}|\d(?:[ \t]\d){3,7}|\d{4,8}/g;

// "Your verification code: X7K9PQ" — letters and digits, accepted only right
// after an unambiguous phrase. A bare "code SAVE20" is a promo code.
const ALNUM_AFTER_ANCHOR =
	/(?:(?:verification|security|login|log[-\s]?in|sign[-\s]?in|one[-\s]?time|access|authentication)\s+code|passcode|otp)\s*(?:is\s*)?[:#-]?\s*([a-z0-9]{4,10})\b/gi;

const MAX_AFTER = 160;
const MAX_BEFORE = 60;

interface Candidate {
	start: number;
	end: number;
	display: string;
	code: string;
}

function looksLikeVerification(text: string): boolean {
	return CONTEXT.some((re) => re.test(text));
}

function isStandalone(text: string, start: number, end: number): boolean {
	const before = text.slice(Math.max(0, start - 3), start);
	const after = text.slice(end, end + 3);
	// Part of a longer digit run joined by separators: a phone number, a date,
	// a card number, a time, a version.
	if (/\d[)\]]?[-./:,]?\s?$/.test(before) || /^\s?[-./:,]?\d/.test(after)) return false;
	// Money, percentages, order/reference numbers. (Ordinals like "21st" are
	// rejected by the caller's letter-adjacency check.)
	if (/[$€£¥₹#+]\s?$/.test(before)) return false;
	if (/^\s?%/.test(after)) return false;
	return true;
}

function numberCandidates(text: string): Candidate[] {
	const out: Candidate[] = [];
	for (const m of text.matchAll(NUMBER)) {
		const start = m.index ?? 0;
		const display = m[0];
		const end = start + display.length;
		if (!isStandalone(text, start, end)) continue;
		// A bare word boundary: "a1234" or "1234b" is an identifier, not a code.
		if (/[a-z]/i.test(text[start - 1] ?? '') || /[a-z]/i.test(text[end] ?? '')) continue;
		const code = display.replace(/[\s-]/g, '');
		if (code.length < 4 || code.length > 8) continue;
		out.push({ start, end, display, code });
	}
	return out;
}

function alnumCandidates(text: string): Candidate[] {
	const out: Candidate[] = [];
	for (const m of text.matchAll(ALNUM_AFTER_ANCHOR)) {
		const token = m[1];
		// Upper-case letters and digits both; an all-digit token is handled
		// above, and anything with lower case is a word ("code below").
		if (!/\d/.test(token) || !/[A-Z]/.test(token) || /[a-z]/.test(token)) continue;
		const start = (m.index ?? 0) + m[0].lastIndexOf(token);
		out.push({ start, end: start + token.length, display: token, code: token });
	}
	return out;
}

function score(c: Candidate, anchors: Array<{ start: number; end: number }>): number | null {
	let best: number | null = null;
	for (const a of anchors) {
		let distance: number | null = null;
		if (c.start >= a.end && c.start - a.end <= MAX_AFTER) distance = c.start - a.end;
		// "504072 is your code" — allowed, but reading order is preferred.
		else if (a.start >= c.end && a.start - c.end <= MAX_BEFORE) distance = (a.start - c.end) * 2;
		if (distance !== null && (best === null || distance < best)) best = distance;
	}
	if (best === null) return null;
	const digits = c.code.replace(/\D/g, '').length === c.code.length;
	if (digits) {
		if (c.code.length !== 6) best += 10;
		// A lone four-digit year is far likelier than a code of that shape.
		if (c.code.length === 4 && /^(?:19|20)\d\d$/.test(c.code)) best += 100;
	}
	return best;
}

function bestIn(text: string): Candidate | null {
	const anchors = [...text.matchAll(ANCHOR)].map((m) => ({
		start: m.index ?? 0,
		end: (m.index ?? 0) + m[0].length
	}));
	if (anchors.length === 0) return null;

	let best: { c: Candidate; s: number } | null = null;
	for (const c of [...numberCandidates(text), ...alnumCandidates(text)]) {
		const s = score(c, anchors);
		if (s !== null && s < 100 && (!best || s < best.s)) best = { c, s };
	}
	return best?.c ?? null;
}

export function detectVerificationCode(subject: string, body: string): DetectedCode | null {
	const subj = subject.replace(/\s+/g, ' ').trim();
	if (!looksLikeVerification(`${subj}\n${body}`)) return null;
	const hit = bestIn(subj) ?? bestIn(body);
	return hit ? { code: hit.code, display: hit.display } : null;
}

// ---------------------------------------------------------------------------
// Body text
// ---------------------------------------------------------------------------

const TEXT_ENTITY = /&(#\d+|#x[0-9a-f]+|nbsp|amp|quot|apos|lt|gt|zwnj|zwj|shy);/gi;
const TEXT_NAMED: Record<string, string> = {
	nbsp: ' ',
	amp: '&',
	quot: '"',
	apos: "'",
	lt: '<',
	gt: '>',
	zwnj: '',
	zwj: '',
	shy: ''
};

/** Readable text from an HTML body — enough structure to keep words apart. */
export function htmlToText(html: string): string {
	return html
		.replace(/<(style|script|head|title)\b[\s\S]*?<\/\1\s*>/gi, ' ')
		.replace(/<!--[\s\S]*?-->/g, ' ')
		// One digit per table cell should read "5 0 4", not "504" or "5\n0\n4".
		.replace(/<\/t[dh]\s*>/gi, '\t')
		.replace(/<(?:br|\/p|\/div|\/tr|\/li|\/h[1-6]|\/table|\/blockquote)\b[^>]*>/gi, '\n')
		.replace(/<[^>]*>/g, '')
		.replace(TEXT_ENTITY, (whole, body: string) => {
			const lower = body.toLowerCase();
			if (lower in TEXT_NAMED) return TEXT_NAMED[lower];
			const code = lower.startsWith('#x') ? parseInt(lower.slice(2), 16) : parseInt(lower.slice(1), 10);
			return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
		})
		// Invisible preheader padding (zero-width and soft-hyphen runs).
		// eslint-disable-next-line no-misleading-character-class -- U+034F is stripped on its own, on purpose
		.replace(/[\u200b-\u200d\u2060\ufeff\u00ad\u034f]/g, '')
		.replace(/[ \t\u00a0]*\n[ \t\u00a0\n]*/g, '\n')
		.replace(/[ \u00a0]{2,}/g, ' ')
		.trim();
}

/**
 * The email's text renditions, best first: the sender's own text part, then
 * its HTML flattened. Both are tried because a text part is sometimes just
 * "view this email in your browser".
 */
function* bodyTexts(email: Email): Generator<string> {
	const values = email.bodyValues ?? {};
	const valueOf = (p: { partId: string }) => values[p.partId]?.value;
	const text = (email.textBody ?? [])
		.filter((p) => p.type?.toLowerCase().startsWith('text/plain'))
		.map(valueOf)
		.filter((v): v is string => !!v);
	if (text.length) yield text.join('\n');
	const html = (email.htmlBody ?? [])
		.filter((p) => p.type?.toLowerCase().startsWith('text/html'))
		.map(valueOf)
		.filter((v): v is string => !!v);
	if (html.length) yield htmlToText(html.join('\n'));
	if (email.preview) yield email.preview;
}

export function detectEmailVerificationCode(email: Email): DetectedCode | null {
	const subject = email.subject ?? '';
	for (const body of bodyTexts(email)) {
		const hit = detectVerificationCode(subject, body);
		if (hit) return hit;
	}
	return null;
}
