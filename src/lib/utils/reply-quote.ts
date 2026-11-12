import type { Email } from '$lib/jmap/types';

/**
 * The original message under a reply: who wrote it, when, the subject, then
 * the message itself. The app's Reply and the agent's replies both quote it
 * this way, so a reply reads the same whoever wrote it.
 */

function escapeHtml(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** "Tue, Nov 11, 2026, 3:04 PM", on the given clock (the browser's when none is given); '' for no date. */
export function quoteDate(iso: string | undefined, timeZone?: string): string {
	const date = new Date(iso ?? '');
	if (Number.isNaN(date.getTime())) return '';
	return date.toLocaleString('en-US', {
		weekday: 'short',
		year: 'numeric',
		month: 'short',
		day: 'numeric',
		hour: 'numeric',
		minute: '2-digit',
		...(timeZone && { timeZone })
	});
}

/**
 * The quote block, or '' when the message has no sender to name. `bodyHtml`
 * goes in as given: the caller makes it safe where it has to be (the app's
 * composer cleans what it loads; the agent's draft skips the composer).
 */
export function replyQuoteHtml(
	email: Pick<Email, 'from' | 'subject' | 'receivedAt'>,
	bodyHtml: string,
	timeZone?: string
): string {
	const sender = email.from?.[0];
	if (!sender) return '';
	const from = sender.name ? `${escapeHtml(sender.name)} &lt;${escapeHtml(sender.email)}&gt;` : escapeHtml(sender.email);
	const date = quoteDate(email.receivedAt, timeZone);
	return (
		'<blockquote style="margin: 0 0 0 0.8ex; border-left: 3px solid #0969da; padding-left: 1ex; color: #59636e;">' +
		`<div><strong>From:</strong> ${from}</div>` +
		(date ? `<div><strong>Date:</strong> ${date}</div>` : '') +
		`<div><strong>Subject:</strong> ${escapeHtml(email.subject ?? '')}</div><br>${bodyHtml}</blockquote>`
	);
}
