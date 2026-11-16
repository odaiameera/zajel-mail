import type { ComposeData } from '$lib/stores/compose';
import { escapeHtml } from './reply';

/**
 * `mailto:` links (RFC 6068), for when this app is the system's mail handler:
 * the browser opens `/mailto?to=<the whole link>`, which hands the link to
 * the inbox as `?mailto=`, where the composer opens with what it asks for.
 */

/** The inbox's query parameter that carries a `mailto:` link to the composer. */
export const MAILTO_PARAM = 'mailto';

export interface MailtoFields {
	to: string[];
	cc: string[];
	bcc: string[];
	subject: string;
	body: string;
}

// A stray `%` (a link written by hand) is kept as it is rather than losing
// the whole field.
function decode(part: string): string {
	try {
		return decodeURIComponent(part);
	} catch {
		return part;
	}
}

function addresses(list: string): string[] {
	return decode(list)
		.split(',')
		.map((a) => a.trim())
		.filter(Boolean);
}

/**
 * Read a `mailto:` link, or a bare address. Only the fields a link may set
 * are read (to, cc, bcc, subject, body); any other header is ignored, as the
 * RFC asks. A `+` stays a plus: the form-encoding rule that makes it a space
 * doesn't apply here, and addresses such as `me+news@example.com` rely on it.
 */
export function parseMailto(raw: string): MailtoFields {
	const out: MailtoFields = { to: [], cc: [], bcc: [], subject: '', body: '' };
	const link = raw.trim().replace(/^mailto:/i, '');
	const at = link.indexOf('?');
	out.to = addresses(at === -1 ? link : link.slice(0, at));
	if (at === -1) return out;

	const bodies: string[] = [];
	for (const pair of link.slice(at + 1).split('&')) {
		const eq = pair.indexOf('=');
		if (eq === -1) continue;
		const name = decode(pair.slice(0, eq)).trim().toLowerCase();
		const value = pair.slice(eq + 1);
		if (name === 'to') out.to.push(...addresses(value));
		else if (name === 'cc') out.cc.push(...addresses(value));
		else if (name === 'bcc') out.bcc.push(...addresses(value));
		else if (name === 'subject') out.subject ||= decode(value).replace(/[\r\n]+/g, ' ').trim();
		else if (name === 'body') bodies.push(decode(value).replace(/\r\n?/g, '\n'));
	}
	out.body = bodies.join('\n');
	return out;
}

// The link's body is plain text; the composer's is HTML. Escaped, so nothing
// a link carries is read as markup.
function textToHtml(text: string): string {
	return text
		.split(/\n{2,}/)
		.map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`)
		.join('');
}

/** What the composer opens with for a `mailto:` link. */
export function composeFromMailto(raw: string): Partial<ComposeData> {
	const m = parseMailto(raw);
	return {
		to: m.to.join(', '),
		cc: m.cc.join(', '),
		bcc: m.bcc.join(', '),
		subject: m.subject,
		body: m.body ? textToHtml(m.body) : ''
	};
}
