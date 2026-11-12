import type { Email, EmailAddress } from '$lib/jmap/types';
import { htmlToPromptText } from '$lib/server/ai/extract-event';
import type { JevSecurityFacts } from './spam';

/**
 * What Jev is shown about one email: the email itself, cut down to the
 * agreed excerpt, and the facts our own code worked out. The two sit in
 * separate fields so text inside the email can't pass itself off as one of
 * the facts. The list is fixed (docs/jev-plan.md).
 */

/** Characters of plain-text body sent, after quoted replies are removed. */
export const BODY_EXCERPT_CHARS = 2000;

/** Facts our code knows and Jev can't see. `null` means "couldn't tell". */
export interface JevFacts {
	sender_in_contacts: boolean | null;
	you_have_written_to_sender: boolean | null;
	you_have_written_in_this_thread: boolean | null;
	/** Your address is in To, not only Cc, Bcc or a list. */
	addressed_to_you_directly: boolean;
	has_list_unsubscribe: boolean;
	list_id: string | null;
	/** `Precedence: bulk`, `list` or `junk`. */
	bulk_precedence: boolean;
	/** `Auto-Submitted` present with any value other than `no`. */
	auto_submitted: boolean;
	/** A no-reply style sender address. */
	sender_looks_automated: boolean;
	contains_sign_in_code: boolean;
	/** Where you have moved this sender's mail before, in a sentence; null if never. */
	sender_history: string | null;
	/** Origin and Stalwart's verdict, sent only while spam checking is on. */
	security?: JevSecurityFacts;
}

export interface JevEmailState {
	email: {
		from: string;
		to: string[];
		cc: string[];
		subject: string;
		body_excerpt: string;
	};
	facts: JevFacts;
}

function formatAddress(a: EmailAddress): string {
	return a.name ? `${a.name} <${a.email}>` : a.email;
}

/**
 * Drop the quoted history under a reply: `>`-prefixed lines, and everything
 * from the first "On … wrote:" or forwarded-message separator down. The new
 * text is what the email is about; the quote is someone else's email.
 */
export function stripQuotedReplies(text: string): string {
	const kept: string[] = [];
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (
			/^On\b.{0,200}\bwrote:$/i.test(trimmed) ||
			/^-{2,}\s*(Original|Forwarded) Message\s*-{2,}$/i.test(trimmed) ||
			/^_{20,}$/.test(trimmed)
		) {
			break;
		}
		if (trimmed.startsWith('>')) continue;
		kept.push(line);
	}
	return kept.join('\n');
}

/** The fetched parts of one media type, joined. */
function partText(email: Email, parts: Email['textBody'], type: string): string {
	return (parts ?? [])
		.filter((part) => part.type?.toLowerCase().startsWith(type))
		.map((part) => email.bodyValues?.[part.partId]?.value ?? '')
		.filter(Boolean)
		.join('\n');
}

/**
 * Plain-text body, quotes removed, whitespace folded, cut to `maxChars`.
 * An HTML-only message lists its html part under `textBody` too (RFC 8621
 * §4.1.4), so the part's type decides, not the list it is in: markup is
 * always flattened to text first.
 */
export function bodyExcerpt(email: Email, maxChars = BODY_EXCERPT_CHARS): string {
	let text = partText(email, email.textBody, 'text/plain');
	if (!text) {
		const html = partText(email, email.htmlBody, 'text/html') || partText(email, email.textBody, 'text/html');
		text = html ? htmlToPromptText(html, maxChars * 3) : email.preview ?? '';
	}
	const cleaned = stripQuotedReplies(text)
		.replace(/[ \t]+/g, ' ')
		.replace(/\n\s*\n+/g, '\n\n')
		.trim();
	return cleaned.length > maxChars ? cleaned.slice(0, maxChars) : cleaned;
}

export function buildEmailState(email: Email, facts: JevFacts): JevEmailState {
	return {
		email: {
			from: email.from?.[0] ? formatAddress(email.from[0]) : '(unknown sender)',
			to: (email.to ?? []).map(formatAddress),
			cc: (email.cc ?? []).map(formatAddress),
			subject: email.subject ?? '',
			body_excerpt: bodyExcerpt(email)
		},
		facts
	};
}
