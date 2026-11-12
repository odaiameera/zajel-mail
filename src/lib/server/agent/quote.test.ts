import { describe, expect, it } from 'vitest';
import type { Email } from '$lib/jmap/types';
import { quoteOriginal, quotedBody } from './quote';

function message(parts: { html?: string; text?: string }): Email {
	return {
		id: 'e1',
		from: [{ name: 'Dana', email: 'dana@example.test' }],
		subject: 'Contract',
		receivedAt: '2026-11-11T09:00:00Z',
		preview: 'preview only',
		htmlBody: parts.html !== undefined ? [{ partId: 'h', type: 'text/html' }] : [],
		textBody: parts.text !== undefined ? [{ partId: 't', type: 'text/plain' }] : [],
		bodyValues: {
			...(parts.html !== undefined && { h: { value: parts.html } }),
			...(parts.text !== undefined && { t: { value: parts.text } })
		}
	} as unknown as Email;
}

describe('quoting the original', () => {
	it('keeps structure, links and direction, and drops what could run or track', () => {
		const body = quotedBody(
			message({
				html:
					'<style>p{color:red}</style><script>alert(1)</script><p onclick="x()" style="color: red; text-align: right" dir="rtl">مرحبا</p>' +
					'<p>See <a href="https://example.test/c" target="_blank">the contract</a> and <a href="javascript:evil()">this</a>.</p>' +
					'<form action="https://evil.example"><input name="pw"></form><iframe src="https://evil.example"></iframe><ul><li>one</li></ul>'
			})
		);
		expect(body).toContain('<p style="text-align:right" dir="rtl">مرحبا</p>');
		expect(body).toContain('<a href="https://example.test/c">the contract</a>');
		expect(body).toContain('<ul><li>one</li></ul>');
		for (const gone of ['<script', 'alert', '<style', 'onclick', 'color', 'javascript:', '<form', '<input', '<iframe', 'target=']) {
			expect(body).not.toContain(gone);
		}
	});

	it('quotes a text-only message as its text, escaped', () => {
		expect(quotedBody(message({ text: 'Line one\n<b>not bold</b>' }))).toBe('<pre style="white-space:pre-wrap">Line one\n&lt;b&gt;not bold&lt;/b&gt;</pre>');
	});

	it('quotes a huge message’s text instead of its HTML', () => {
		const huge = `<p>${'x'.repeat(250_000)}</p>`;
		expect(quotedBody(message({ html: huge, text: 'The short version' }))).toContain('The short version');
	});

	it('wraps it in the same header as the app’s Reply, on the user’s clock', () => {
		const quote = quoteOriginal(message({ text: 'Hi' }), 'America/New_York');
		expect(quote).toContain('<strong>From:</strong> Dana &lt;dana@example.test&gt;');
		expect(quote).toContain('Wed, Nov 11, 2026, 4:00 AM');
		expect(quoteOriginal({ ...message({ text: 'Hi' }), from: [] }, 'UTC')).toBeNull();
	});
});
