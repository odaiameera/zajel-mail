import { describe, expect, it } from 'vitest';
import { quoteDate, replyQuoteHtml } from './reply-quote';

const email = { from: [{ name: 'Dana "D" <Ops>', email: 'dana@example.test' }], subject: 'Lunch & <plans>', receivedAt: '2026-11-11T15:04:00Z' };

describe('reply quote', () => {
	it('names the sender, the date on the given clock and the subject, then the body', () => {
		const html = replyQuoteHtml(email, '<p>Does Thursday work?</p>', 'Asia/Amman');
		expect(html).toContain('<strong>From:</strong> Dana &quot;D&quot; &lt;Ops&gt; &lt;dana@example.test&gt;');
		expect(html).toContain('<strong>Date:</strong> Wed, Nov 11, 2026, 6:04 PM');
		expect(html).toContain('<strong>Subject:</strong> Lunch &amp; &lt;plans&gt;');
		expect(html).toMatch(/^<blockquote [^>]+>.*<br><p>Does Thursday work\?<\/p><\/blockquote>$/);
	});

	it('leaves out a date it can’t read, and quotes nothing without a sender', () => {
		expect(replyQuoteHtml({ ...email, receivedAt: '' }, 'x')).not.toContain('Date:');
		expect(replyQuoteHtml({ ...email, from: [] }, 'x')).toBe('');
		expect(quoteDate(undefined)).toBe('');
	});
});
