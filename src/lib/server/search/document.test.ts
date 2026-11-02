import { describe, expect, it } from 'vitest';
import { chunkText, CHUNK_CHARS, emailDocument, MAX_CHUNKS, withoutQuotes } from './document';
import { fakeEmail } from './__fixtures__/fakes';

describe('emailDocument', () => {
	it('titles with the subject and starts each chunk with the sender', () => {
		const doc = emailDocument(fakeEmail({ id: 'a', receivedAt: '2026-03-01T10:00:00Z', subject: ' Kitchen sink ', from: 'sam@plumb.example', body: 'The quote is attached.' }));
		expect(doc).toEqual({ title: 'Kitchen sink', chunks: ['From: sam@plumb.example\nThe quote is attached.'] });
	});

	it('reads the HTML part when there is no plain text', () => {
		const email = fakeEmail({ id: 'h', receivedAt: '2026-03-01T10:00:00Z' });
		email.textBody = [];
		email.htmlBody = [{ partId: '2', blobId: 'x', type: 'text/html', name: null }];
		email.bodyValues = { '2': { value: '<p>Boarding at <b>gate 4</b></p>', isEncodingProblem: false, isTruncated: false } };
		expect(emailDocument(email).chunks[0]).toContain('Boarding at gate 4');
	});

	it('still has a chunk when the message has no text', () => {
		const doc = emailDocument(fakeEmail({ id: 'e', receivedAt: '2026-03-01T10:00:00Z', subject: 'Photo' }));
		expect(doc.chunks).toEqual(['From: someone@example.com']);
	});

	it('keeps Arabic text as it is', () => {
		const doc = emailDocument(fakeEmail({ id: 'ar', receivedAt: '2026-03-01T10:00:00Z', subject: 'عرض سعر', body: 'مرحبا، هذا عرض السعر لإصلاح التسريب.' }));
		expect(doc.title).toBe('عرض سعر');
		expect(doc.chunks[0]).toContain('هذا عرض السعر لإصلاح التسريب.');
	});
});

describe('withoutQuotes', () => {
	it('drops quoted lines and the line that introduces them', () => {
		const text = 'Sounds good.\n\nOn Mon, Sam wrote:\n> The quote is 400.\n> Thanks';
		expect(withoutQuotes(text)).toBe('Sounds good.');
		expect(withoutQuotes('في يوم الاثنين، سام كتب:\n> نص\nشكرا')).toBe('شكرا');
	});
});

describe('chunkText', () => {
	it('splits at a space near each boundary, at most MAX_CHUNKS pieces', () => {
		const text = Array.from({ length: 1000 }, (_, i) => `word${i}`).join(' ');
		const chunks = chunkText(text);
		expect(chunks).toHaveLength(MAX_CHUNKS);
		for (const chunk of chunks) {
			expect(chunk.length).toBeLessThanOrEqual(CHUNK_CHARS);
			expect(chunk).toMatch(/^word\d+( word\d+)*$/);
		}
	});

	it('cuts hard when there is nowhere to split', () => {
		expect(chunkText('x'.repeat(CHUNK_CHARS + 10)).map((c) => c.length)).toEqual([CHUNK_CHARS, 10]);
	});
});
