import { describe, expect, it } from 'vitest';
import { sanitizeSignatureHtml } from './sanitize-signature';

describe('signature sanitizer', () => {
	it('keeps a paragraph’s direction', () => {
		expect(sanitizeSignatureHtml('<p dir="rtl">مع التحية</p><p dir="LTR">Odai</p>')).toBe(
			'<p dir="rtl">مع التحية</p><p dir="ltr">Odai</p>'
		);
	});

	it('drops any other dir, and dir anywhere but a paragraph', () => {
		expect(sanitizeSignatureHtml('<p dir="auto">a</p><p dir="x" onclick="y">b</p><span dir="rtl">c</span>')).toBe(
			'<p>a</p><p>b</p><span>c</span>'
		);
	});
});
