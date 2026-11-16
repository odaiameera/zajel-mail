// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { editableBody, outgoingBody } from './compose-html';
import { htmlToText } from './html-to-text';

const send = (html: string) => outgoingBody(html, 'Calibri, sans-serif', '12pt');
const inner = (html: string) => send(html).replace(/^<div[^>]*>/, '').replace(/<\/div>$/, '');

describe('outgoingBody', () => {
	it('wraps the message in the font, size and line height the editor showed', () => {
		expect(send('<p>Hi</p>')).toBe(
			'<div style="font-family: Calibri, sans-serif; font-size: 12pt; line-height: 1.5;"><p style="margin: 0;">Hi</p></div>'
		);
	});

	it('keeps lines tight and blank lines blank', () => {
		expect(inner('<p>One</p><p>Two</p><p></p><p>Three</p>')).toBe(
			'<p style="margin: 0;">One</p><p style="margin: 0;">Two</p><p style="margin: 0;"><br></p><p style="margin: 0;">Three</p>'
		);
	});

	it('adds to a style already there without replacing what it sets', () => {
		expect(inner('<p style="text-align: center">x</p>')).toBe('<p style="text-align: center; margin: 0;">x</p>');
		expect(inner('<p style="margin-top: 1em;">x</p>')).toBe('<p style="margin-top: 1em;">x</p>');
		expect(inner('<blockquote style="border-left: 3px solid #0969da; margin: 0 0 0 4px">q</blockquote>')).toContain(
			'style="border-left: 3px solid #0969da; margin: 0 0 0 4px; padding-inline-start: 1em;'
		);
	});

	it('carries the look of lists, headings, quotes, tables and images', () => {
		const html = inner(
			'<h2>T</h2><ul><li><p>a</p></li></ul><blockquote><p>q</p></blockquote><table><tbody><tr><th>h</th><td>c</td></tr></tbody></table><img src="x.png" alt="a > b">'
		);
		expect(html).toContain('<h2 style="font-size: 1.25em; font-weight: 600; margin: 0.5em 0;">');
		expect(html).toContain('<ul style="margin: 0.25em 0; padding-inline-start: 1.5em;"><li><p style="margin: 0;">a</p></li></ul>');
		expect(html).toContain('border-inline-start: 3px solid #d1d9e0; color: #59636e;"><p style="margin: 0;">q</p></blockquote>');
		expect(html).toContain('<table style="border-collapse: collapse; width: 100%; margin: 0.5em 0;">');
		expect(html).toContain('<td style="border: 1px solid #d1d9e0; padding: 6px 10px;">c</td>');
		expect(html).toContain('background: #f6f8fa; font-weight: 600;">h</th>');
		expect(html).toMatch(/<img src="x\.png" alt="a (>|&gt;) b" style="max-width: 100%; height: auto;">/);
	});

	it('leaves text, marks and the signature block as they are', () => {
		const body = '<p>Hello <strong>there</strong> <a href="https://example.com/?a=1&amp;b=2">link</a></p><div class="ameera-signature"><p>Odai</p></div>';
		expect(inner(body)).toBe(
			'<p style="margin: 0;">Hello <strong>there</strong> <a href="https://example.com/?a=1&amp;b=2">link</a></p><div class="ameera-signature"><p style="margin: 0;">Odai</p></div>'
		);
	});
});

describe('editableBody', () => {
	it('gives the editor back its empty paragraphs', () => {
		expect(editableBody('<p style="margin: 0;">One</p><p style="margin: 0;"><br></p><p><br/></p><p>Two<br>Three</p>')).toBe(
			'<p style="margin: 0;">One</p><p style="margin: 0;"></p><p></p><p>Two<br>Three</p>'
		);
	});

	it('undoes what sending did to blank lines, so a draft reopens as written', () => {
		const written = '<p>One</p><p></p><p>Two</p>';
		expect(editableBody(inner(written)).replace(/ style="margin: 0;"/g, '')).toBe(written);
	});
});

describe('the plain-text half of a composed message', () => {
	it('has the lines and blank lines that were written', () => {
		const html = send('<p>Hi Dana,</p><p></p><p>First line.</p><p>Second line.</p><p></p><p>Thanks,</p><p>Odai</p>');
		expect(htmlToText(html)).toBe('Hi Dana,\n\nFirst line.\nSecond line.\n\nThanks,\nOdai');
	});

	it('still reads other paragraphs as paragraphs', () => {
		expect(htmlToText('<p>One</p><p>Two</p>')).toBe('One\n\nTwo');
		expect(htmlToText('<p style="margin: 0.5em 0">One</p><p style="margin-top:0">Two</p>')).toBe('One\n\nTwo');
	});
});
