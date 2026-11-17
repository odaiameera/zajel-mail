// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { splitQuoted } from './quoted-text';

describe('splitQuoted', () => {
	it("trims this app's own quote, leaving the reply and its signature", () => {
		const html =
			'<div data-zajel-body><div>Thanks!</div><div><br></div><div id="zajel-signature"><div>Odai</div></div><div><br></div>' +
			'<blockquote id="zajel-quote"><div><strong>From:</strong> Dana</div><p>Original</p></blockquote></div>';
		expect(splitQuoted(html)).toEqual({
			main: '<div data-zajel-body=""><div>Thanks!</div><div><br></div><div id="zajel-signature"><div>Odai</div></div></div>',
			trimmed: true
		});
	});

	it("trims Gmail's, with its \"wrote:\" line inside", () => {
		const html = '<div dir="ltr">Sounds good.</div><br><div class="gmail_quote"><div class="gmail_attr">On Mon, Nov 16, 2026 at 10:00 AM Dana &lt;d@x.test&gt; wrote:<br></div><blockquote class="gmail_quote">Earlier</blockquote></div>';
		expect(splitQuoted(html)).toEqual({ main: '<div dir="ltr">Sounds good.</div>', trimmed: true });
	});

	it("trims Apple Mail's and Thunderbird's, with the line that introduces them", () => {
		expect(splitQuoted('<div>Yes.</div><div><br></div><div>On 16 Nov 2026, at 10:00, Dana wrote:</div><blockquote type="cite"><div>Earlier</div></blockquote>')).toEqual({
			main: '<div>Yes.</div>',
			trimmed: true
		});
		expect(splitQuoted('<p>Yes.</p><div class="moz-cite-prefix">On 16/11/2026 10:00, Dana wrote:<br></div><blockquote type="cite">Earlier</blockquote>')).toEqual({
			main: '<p>Yes.</p>',
			trimmed: true
		});
	});

	it("trims Outlook's, on the web and on the desktop", () => {
		expect(splitQuoted('<div>Agreed.</div><div id="appendonsend"></div><hr><div id="divRplyFwdMsg"><b>From:</b> Dana</div><div>Earlier</div>')).toEqual({
			main: '<div>Agreed.</div>',
			trimmed: true
		});
		expect(
			splitQuoted('<div class="WordSection1"><p class="MsoNormal">Agreed.</p><div style="border:none;border-top:solid #E1E1E1 1.0pt;padding:3.0pt 0in 0in 0in"><p class="MsoNormal"><b>From:</b> Dana<br><b>Sent:</b> Monday</p></div><p class="MsoNormal">Earlier</p></div>')
		).toEqual({ main: '<div class="WordSection1"><p class="MsoNormal">Agreed.</p></div>', trimmed: true });
	});

	it('trims from the quote on, wherever it sits in the markup', () => {
		expect(splitQuoted('<div><div><p>Mine</p><blockquote>Theirs</blockquote><p>Under the quote</p></div><p>After</p></div>')).toEqual({
			main: '<div><div><p>Mine</p></div></div>',
			trimmed: true
		});
	});

	it('leaves a forward whole: the quote is the message', () => {
		const ours = '<div>FYI</div><div id="zajel-quote"><div><strong>---------- Forwarded message ----------</strong></div><p>Body</p></div>';
		expect(splitQuoted(ours)).toEqual({ main: ours, trimmed: false });
		const gmail = '<div>FYI</div><div class="gmail_quote">---------- Forwarded message ---------<br>From: Dana</div>';
		expect(splitQuoted(gmail).trimmed).toBe(false);
	});

	it('leaves a message that is nothing but its quote, and one with none', () => {
		const only = '<blockquote type="cite"><p>Everything</p></blockquote>';
		expect(splitQuoted(only)).toEqual({ main: only, trimmed: false });
		expect(splitQuoted('<p>Just a message</p>')).toEqual({ main: '<p>Just a message</p>', trimmed: false });
		expect(splitQuoted('')).toEqual({ main: '', trimmed: false });
	});

	it('keeps a picture or a table as the sender\'s own content', () => {
		expect(splitQuoted('<div><img src="cid:a"></div><blockquote>Earlier</blockquote>')).toEqual({ main: '<div><img src="cid:a"></div>', trimmed: true });
	});
});
