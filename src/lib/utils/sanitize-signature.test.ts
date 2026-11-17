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

describe('a signature written in the new editor', () => {
	it('keeps its lines, font, size, direction and emphasis', () => {
		const html =
			'<div style="direction: rtl; font-family: Cairo, sans-serif; font-size: 14pt;">مع التحية</div>' +
			'<div><br></div><div dir="ltr"><b>Odai</b> <i>A</i> <u>x</u> <a href="https://example.com">site</a></div>';
		expect(sanitizeSignatureHtml(html)).toBe(
			'<div style="direction:rtl;font-family:Cairo, sans-serif;font-size:14pt">مع التحية</div>' +
				'<div><br /></div><div dir="ltr"><b>Odai</b> <i>A</i> <u>x</u> <a href="https://example.com" rel="noopener noreferrer" target="_blank">site</a></div>'
		);
	});

	it('still strips every other style, and anything that could run', () => {
		expect(
			sanitizeSignatureHtml('<div style="position:fixed;color:red;font-size:99em" onclick="x()" class="y" id="z">a</div><script>b()</script><img src="x">')
		).toBe('<div>a</div>');
	});
});
