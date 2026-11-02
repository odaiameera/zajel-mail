import { describe, expect, it } from 'vitest';
import type { Email, EmailAttachment } from '$lib/jmap/types';
import { attachmentCards } from './list';

const part = (over: Partial<EmailAttachment>): EmailAttachment => ({
	partId: 'p',
	blobId: 'b',
	type: 'application/pdf',
	name: 'file.pdf',
	size: 1000,
	cid: null,
	disposition: 'attachment',
	...over
});

const email = (over: Partial<Email>): Pick<Email, 'attachments' | 'htmlBody' | 'textBody'> => ({
	attachments: [],
	htmlBody: [],
	textBody: [],
	...over
});

describe('attachmentCards', () => {
	it('hides only the parts the body draws inline, not every part with a cid or inline disposition', () => {
		const cards = attachmentCards(
			email({
				attachments: [
					// The logo an HTML body shows through <img src="cid:…">.
					part({ blobId: 'B-logo', name: 'logo.png', type: 'image/png', cid: 'logo@x', disposition: 'inline' }),
					// Outlook: an ordinary attachment that happens to carry a Content-ID.
					part({ blobId: 'B-report', name: 'report.pdf', cid: 'f_abc@namprd.outlook.com' }),
					// Apple Mail: a file placed in the text, sent as inline.
					part({ blobId: 'B-notes', name: 'notes.pdf', disposition: 'inline' }),
					// An image with a cid the body never references.
					part({ blobId: 'B-spare', name: 'spare.png', type: 'image/png', cid: 'spare@x', disposition: 'inline' })
				]
			}),
			new Set(['B-logo'])
		);
		expect(cards.map((c) => c.name)).toEqual(['report.pdf', 'notes.pdf', 'spare.png']);
	});

	it('lists a picture that sits in the body of a multipart/mixed message', () => {
		const text = { partId: '1', blobId: 'T1', type: 'text/plain', name: null };
		const photo = { partId: '2', blobId: 'P1', type: 'image/jpeg', name: 'IMG_0042.jpeg', size: 2_400_000 };
		const cards = attachmentCards(
			email({
				attachments: [],
				htmlBody: [text, photo, { ...text, partId: '3', blobId: 'T3' }],
				textBody: [text, photo, { ...text, partId: '3', blobId: 'T3' }]
			}),
			new Set()
		);
		expect(cards).toEqual([
			{ partId: '2', blobId: 'P1', type: 'image/jpeg', name: 'IMG_0042.jpeg', size: 2_400_000, cid: null, disposition: 'inline' }
		]);
	});

	it('lists each blob once, attachments first', () => {
		const pdf = part({ blobId: 'B1', name: 'a.pdf' });
		const cards = attachmentCards(
			email({
				attachments: [pdf, part({ blobId: 'B1', name: 'a-again.pdf' })],
				htmlBody: [{ partId: '9', blobId: 'B1', type: 'application/pdf', name: 'a.pdf' }]
			}),
			new Set()
		);
		expect(cards).toEqual([pdf]);
	});
});
