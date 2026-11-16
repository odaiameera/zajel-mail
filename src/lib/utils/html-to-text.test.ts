import { describe, expect, it } from 'vitest';
import { htmlToText } from './html-to-text';

describe('htmlToText', () => {
	it('turns paragraphs and line breaks into newlines', () => {
		expect(htmlToText('<p>Hi Dana,</p><p>Line one<br>Line two</p>')).toBe('Hi Dana,\n\nLine one\nLine two');
	});

	it('keeps link targets, without repeating a bare URL', () => {
		expect(htmlToText('<p>See <a href="https://x.test/a">the doc</a> or https://x.test/b</p>')).toBe(
			'See the doc (https://x.test/a) or https://x.test/b'
		);
		expect(htmlToText('<a href="https://x.test">https://x.test</a>')).toBe('https://x.test');
		expect(htmlToText('<a href="mailto:a@b.test">a@b.test</a>')).toBe('a@b.test');
	});

	it('bullets list items', () => {
		expect(htmlToText('<ul><li>One</li><li>Two</li></ul>')).toBe('• One\n• Two');
	});

	it('quotes replies with > per level', () => {
		const html = '<p>Thanks!</p><blockquote><p>Original</p><blockquote><p>Older</p></blockquote></blockquote>';
		expect(htmlToText(html)).toBe('Thanks!\n\n> Original\n>\n> > Older');
	});

	it('decodes entities and drops styles and comments', () => {
		expect(htmlToText('<style>p{color:red}</style><!-- x --><p>Fish &amp; chips&nbsp;&#8212; &lt;3</p>')).toBe(
			'Fish & chips — <3'
		);
	});

	it('ignores source newlines inside text', () => {
		expect(htmlToText('<p>one\ntwo</p>')).toBe('one two');
	});
});

describe('a message written in the composer', () => {
	const wrap = (inner: string) => `<div data-zajel-body style="font-family: Calibri, sans-serif; font-size: 12pt; line-height: 1.5;">${inner}</div>`;

	it('has the lines and blank lines that were written', () => {
		const html = wrap('<div>Hi Dana,</div><div><br></div><div>First line.</div><div>Second line.</div><div><br></div><div>Thanks,</div><div>Odai</div>');
		expect(htmlToText(html)).toBe('Hi Dana,\n\nFirst line.\nSecond line.\n\nThanks,\nOdai');
	});

	it('reads a reply, its signature and the quoted message', () => {
		const html = wrap(
			'<div>Thanks!</div><div><br></div><div id="zajel-signature"><div>Odai</div><div>Zajel</div></div><div><br></div>' +
				'<blockquote id="zajel-quote"><div><strong>From:</strong> Dana</div><div><strong>Subject:</strong> Q4</div><br><p>Original</p></blockquote>'
		);
		expect(htmlToText(html)).toBe('Thanks!\n\nOdai\nZajel\n\n> From: Dana\n> Subject: Q4\n>\n> Original');
	});

	it('adds no blank line for a line inside a line, a break at the end of one, or text before one', () => {
		expect(htmlToText('<div><div>A</div></div><div>B<br></div><div>C</div>')).toBe('A\nB\nC');
		expect(htmlToText('loose<div>A</div>after')).toBe('loose\nA\nafter');
		expect(htmlToText('<div>A</div><div>&nbsp;</div><div>B</div>')).toBe('A\n\nB');
	});

	it('reads the old editor’s lines the same way, and still gives other paragraphs their gap', () => {
		expect(htmlToText('<p style="margin: 0;">One</p><p style="margin: 0;"><br></p><p style="margin: 0;">Two</p>')).toBe('One\n\nTwo');
		expect(htmlToText('<p>One</p><p>Two</p>')).toBe('One\n\nTwo');
		expect(htmlToText('<p style="margin: 0.5em 0">One</p><p style="margin-top:0">Two</p>')).toBe('One\n\nTwo');
	});
});
