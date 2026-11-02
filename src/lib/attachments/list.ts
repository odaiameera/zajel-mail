import type { Email, EmailAttachment } from '$lib/jmap/types';

/** A `htmlBody`/`textBody` entry, with the body properties JMAP sends by default. */
type BodyPart = {
	partId: string;
	blobId: string;
	type: string;
	name: string | null;
	size?: number;
	cid?: string | null;
};

/**
 * The parts the reading view lists as attachment cards.
 *
 * JMAP's `attachments` is every part that is not body text, which includes
 * the images an HTML body draws through `cid:` — those belong in the body,
 * not in the list. The list used to be filtered the other way round: any part
 * with a Content-ID or an `inline` disposition was taken for one of those
 * images. But Outlook gives ordinary PDF attachments a Content-ID, and Apple
 * Mail sends a file placed in the text as `inline`, so real attachments
 * vanished. A part is left out only when the body actually references its
 * cid (`inlineBlobIds`, reported by prepareEmailForReading).
 *
 * The other way round, too: a photo dropped between two paragraphs of a
 * multipart/mixed message (a phone's "text, picture, text") is, under RFC
 * 8621's parse rules, a body part rather than an attachment, so it sits in
 * `htmlBody` and `textBody` where the HTML renderer (text parts only) never
 * shows it. Those parts become cards, so the picture is one click away.
 */
export function attachmentCards(
	email: Pick<Email, 'attachments' | 'htmlBody' | 'textBody'>,
	inlineBlobIds: ReadonlySet<string>
): EmailAttachment[] {
	const out: EmailAttachment[] = [];
	const seen = new Set<string>();
	const add = (part: EmailAttachment) => {
		if (inlineBlobIds.has(part.blobId) || seen.has(part.blobId)) return;
		seen.add(part.blobId);
		out.push(part);
	};
	for (const part of email.attachments ?? []) add(part);
	for (const part of [...(email.htmlBody ?? []), ...(email.textBody ?? [])] as BodyPart[]) {
		const type = part.type?.toLowerCase() ?? '';
		if (type.startsWith('text/') || type.startsWith('multipart/')) continue;
		add({
			partId: part.partId,
			blobId: part.blobId,
			type: part.type,
			name: part.name ?? null,
			size: part.size ?? 0,
			cid: part.cid ?? null,
			disposition: 'inline'
		});
	}
	return out;
}
