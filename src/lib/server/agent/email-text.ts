import type { Email } from '$lib/jmap/types';
import { htmlToPromptText } from '$lib/server/ai/extract-event';

/** Plain text of a message: its text/plain part, or its HTML turned into text. */
export function emailBodyText(email: Email, max = 8000): string {
	const values = email.bodyValues ?? {};
	const join = (parts: Email['textBody']) =>
		(parts ?? []).map((part) => values[part.partId]?.value ?? '').join('\n').trim();
	const plain = join(email.textBody?.filter((part) => part.type?.toLowerCase().startsWith('text/plain')));
	if (plain) return plain.slice(0, max);
	const html = join(email.htmlBody?.filter((part) => part.type?.toLowerCase().startsWith('text/html')));
	return html ? htmlToPromptText(html, max) : (email.preview ?? '');
}
