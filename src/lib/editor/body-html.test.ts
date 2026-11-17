// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
	BLANK_LINE,
	QUOTE_ID,
	SIGNATURE_ID,
	applySignature,
	hasWrittenContent,
	incomingBody,
	inlineImageIds,
	isLegacyDraft,
	outgoingBody,
	signatureLines
} from './body-html';

const B = BLANK_LINE;
const quote = (inner = '<div>original</div>') => `<blockquote id="${QUOTE_ID}">${inner}</blockquote>`;
const sig = (inner: string) => `<div id="${SIGNATURE_ID}">${inner}</div>`;

describe('incomingBody', () => {
	it('keeps the formatting a message was written with', () => {
		const html =
			'<table cellpadding="0" style="border-collapse:collapse;width:420px"><tbody><tr><td style="background:#1f4e79;color:#ffffff;padding:6px 10px">Item</td></tr></tbody></table>' +
			'<p style="margin:0in;text-align:center"><span style="color:#c00000;font-weight:bold">Q4</span> <font face="Georgia" size="2">x</font></p>';
		const out = incomingBody(html);
		expect(out).toContain('border-collapse:collapse');
		expect(out).toContain('background:#1f4e79');
		expect(out).toContain('<span style="color:#c00000;font-weight:bold">Q4</span>');
		expect(out).toContain('<font face="Georgia" size="2">x</font>');
	});

	it('lets nothing through that could run, post or reach outside the message', () => {
		const out = incomingBody(
			'<p onclick="x()">a</p><img src="x" onerror="y()"><script>z()</scr' +
				'ipt><style>body{display:none}</style><form action="https://evil.example"><input name="q"><button>go</button></form>' +
				'<iframe src="https://evil.example"></iframe><a href="javascript:alert(1)">l</a><svg><script>q()</scr' +
				'ipt></svg><object data="x"></object><link rel="stylesheet" href="x"><base href="https://evil.example/">'
		);
		for (const bad of ['onclick', 'onerror', '<script', '<style', '<form', '<input', '<button', '<iframe', 'javascript:', '<svg', '<object', '<link', '<base']) {
			expect(out, bad).not.toContain(bad);
		}
		expect(out).toContain('<p>a</p>');
	});

	it('drops classes, and CSS that would lift a message out of its place', () => {
		const out = incomingBody('<div class="x" style="position:fixed;top:0;z-index:9999;color:red">over</div><div style="position: absolute">y</div>');
		expect(out).not.toContain('class=');
		expect(out).not.toMatch(/position|z-index/);
		expect(out).toContain('color: red');
	});

	it("keeps only the editor's own ids, and none of them inside the quoted message", () => {
		const out = incomingBody(
			`<div id="app">x</div>${sig('<div>Me</div>')}${quote(`<div id="${SIGNATURE_ID}">theirs</div><div id="${QUOTE_ID}">older</div><div id="login">z</div>`)}`
		);
		expect(out.match(/id="/g)).toHaveLength(2);
		expect(out).toContain(sig('<div>Me</div>'));
		expect(out).toContain(`<blockquote id="${QUOTE_ID}"><div>theirs</div><div>older</div><div>z</div></blockquote>`);
	});

	it('reads the signature mark older drafts carry', () => {
		expect(incomingBody('<p>Hi</p><div class="ameera-signature"><p>Odai</p></div>')).toBe(`<p>Hi</p>${sig('<p>Odai</p>')}`);
	});

	it('takes the sent wrapper off, so a draft saved again is not wrapped twice', () => {
		const sent = outgoingBody('<div>Hi</div>', 'Calibri, sans-serif', '12pt');
		expect(incomingBody(sent)).toBe('<div>Hi</div>');
		expect(incomingBody(outgoingBody(incomingBody(sent), 'Calibri, sans-serif', '12pt'))).toBe('<div>Hi</div>');
		// From before the wrapper was marked.
		expect(incomingBody('<div style="font-family: Calibri, sans-serif; font-size: 12pt;"><p>Hi</p></div>')).toBe('<p>Hi</p>');
		// Not a wrapper: a message that is one styled block.
		expect(incomingBody('<div style="color: red;">Hi</div>')).toBe('<div style="color: red;">Hi</div>');
	});

	it('gives a blank line its height back', () => {
		expect(incomingBody('<p>One</p><p></p><p>Two</p>')).toBe('<p>One</p><p><br></p><p>Two</p>');
	});

	it("opens a draft from the old editor with the spacing it was written in, and leaves a quoted message's own", () => {
		const old = '<div style="font-family: Calibri, sans-serif; font-size: 12pt;"><p>One</p><p></p><p style="text-align: center">Two</p></div>';
		expect(isLegacyDraft(old)).toBe(true);
		expect(isLegacyDraft(outgoingBody('<div>x</div>', 'Calibri, sans-serif', '12pt'))).toBe(false);
		expect(incomingBody(old, { legacyParagraphs: true })).toBe(
			'<p style="margin: 0;">One</p><p style="margin: 0;"><br></p><p style="text-align: center; margin: 0;">Two</p>'
		);
		expect(incomingBody(`<p>Mine</p>${quote('<p>Theirs</p>')}`, { legacyParagraphs: true })).toBe(
			`<p style="margin: 0;">Mine</p>${quote('<p>Theirs</p>')}`
		);
	});

	it('opens links in a new tab without a way back to this one', () => {
		expect(incomingBody('<a href="https://example.com">x</a>')).toBe(
			'<a href="https://example.com" target="_blank" rel="noopener noreferrer">x</a>'
		);
	});
});

describe('pictures', () => {
	const cid = { 'logo@x': '/api/email/e1/attachment/b9?name=logo.png&inline=1' };

	it('shows inline parts and, when allowed, remote pictures; and sends each as it came', () => {
		const html = '<div><img src="cid:logo@x" alt="l"><img src="https://cdn.example/a.png?x=1&amp;y=2"><img src="data:image/png;base64,AAAA"></div>';
		const shown = incomingBody(html, { images: { cid, remote: true } });
		expect(shown).toContain('src="/api/email/e1/attachment/b9?name=logo.png&amp;inline=1#cid=logo%40x"');
		expect(shown).toContain('src="/api/image-proxy?url=https%3A%2F%2Fcdn.example%2Fa.png%3Fx%3D1%26y%3D2"');
		expect(shown).toContain('src="data:image/png;base64,AAAA"');
		const sent = outgoingBody(shown, 'Calibri, sans-serif', '12pt');
		expect(sent).toContain('<img src="cid:logo@x" alt="l">');
		expect(sent).toContain('<img src="https://cdn.example/a.png?x=1&amp;y=2">');
		expect(sent).toContain('src="data:image/png;base64,AAAA"');
	});

	it('leaves remote pictures unloaded when the reader chose that, and still sends them', () => {
		const shown = incomingBody('<img src="https://cdn.example/a.png">', { images: { remote: false } });
		expect(shown).toBe('<img src="https://cdn.example/a.png">');
		expect(outgoingBody(shown, 'Calibri, sans-serif', '12pt')).toContain('<img src="https://cdn.example/a.png">');
	});

	it('survives leaving the editor and coming back, as an undone send does', () => {
		const shown = incomingBody('<img src="cid:logo@x"><img src="https://cdn.example/a.png">', { images: { cid, remote: true } });
		expect(incomingBody(shown)).toBe(shown);
	});

	it('names the inline parts a body draws', () => {
		const shown = incomingBody('<img src="cid:logo@x"><img src="cid:gone@x">', { images: { cid } });
		expect([...inlineImageIds(shown)].sort()).toEqual(['gone@x', 'logo@x']);
	});
});

describe('outgoingBody', () => {
	it('wraps the message in the font, size and line height the editor showed', () => {
		expect(outgoingBody('<div>Hi</div>', 'Calibri, sans-serif', '12pt')).toBe(
			'<div data-zajel-body style="font-family: Calibri, sans-serif; font-size: 12pt; line-height: 1.5;"><div>Hi</div></div>'
		);
	});

	it("drops the editor's working ids and keeps the two marks", () => {
		const out = outgoingBody(`<table id="table_0"><tbody><tr><td><img id="image_0" src="data:image/png;base64,AA"></td></tr></tbody></table>${sig('<div>Me</div>')}${quote()}`, 'Calibri, sans-serif', '12pt');
		expect(out).not.toMatch(/table_0|image_0/);
		expect(out).toContain(`id="${SIGNATURE_ID}"`);
		expect(out).toContain(`id="${QUOTE_ID}"`);
	});

	it('says a direction as an attribute too', () => {
		expect(outgoingBody('<div style="direction: rtl;">مرحبا</div>', 'Calibri, sans-serif', '12pt')).toContain(
			'<div style="direction: rtl;" dir="rtl">مرحبا</div>'
		);
	});
});

describe('applySignature', () => {
	const S = '<div>Odai</div>';

	it('ends a new message, under a line to write on and one of space', () => {
		expect(applySignature('', S)).toBe(`${B}${B}${sig(S)}`);
		expect(applySignature(B, S)).toBe(`${B}${B}${sig(S)}`);
		expect(applySignature('<div>Hello</div>', S)).toBe(`<div>Hello</div>${B}${sig(S)}`);
	});

	it('goes under the reply and above the quoted message, never below it', () => {
		const reply = `${B}${B}${quote()}`;
		expect(applySignature(reply, S)).toBe(`${B}${B}${sig(S)}${B}${quote()}`);
		expect(applySignature(`<div>Thanks</div>${B}${quote()}`, S)).toBe(`<div>Thanks</div>${B}${sig(S)}${B}${quote()}`);
		expect(applySignature(`<div>Thanks</div>${quote()}`, S)).toBe(`<div>Thanks</div>${B}${sig(S)}${B}${quote()}`);
	});

	it('replaces the one there, and applying the same one twice changes nothing', () => {
		const once = applySignature(`${B}${B}${quote()}`, S);
		expect(applySignature(once, S)).toBe(once);
		expect(applySignature(once, '<div>Other</div>')).toBe(`${B}${B}${sig('<div>Other</div>')}${B}${quote()}`);
		const fresh = applySignature('', S);
		expect(applySignature(fresh, S)).toBe(fresh);
	});

	it('takes the signature out for none, leaving the message as it was', () => {
		expect(applySignature(applySignature(`${B}${B}${quote()}`, S), null)).toBe(`${B}${B}${quote()}`);
		expect(applySignature(applySignature('<div>Hello</div>', S), null)).toBe(`<div>Hello</div>${B}`);
	});

	it("leaves a signature inside the quoted message alone: it is someone's, or an older one of yours", () => {
		const quoted = quote(`<div>earlier</div><div id="${SIGNATURE_ID}">Old me</div>`);
		// As it would be after cleaning, the inner mark is gone; even if it were not:
		expect(applySignature(`${B}${B}${quoted}`, S)).toBe(`${B}${B}${sig(S)}${B}${quoted}`);
	});

	it('writes a signature from the old editor as lines', () => {
		expect(signatureLines('<p dir="rtl">مع التحية</p><p></p><p>Odai <strong>A</strong></p>')).toBe(
			'<div dir="rtl">مع التحية</div><div><br></div><div>Odai <strong>A</strong></div>'
		);
	});
});

describe('hasWrittenContent', () => {
	it('counts what was written, not the signature or the quoted message', () => {
		expect(hasWrittenContent(`${B}${B}${sig('<div>Odai</div>')}${B}${quote()}`)).toBe(false);
		expect(hasWrittenContent(`<div>Hi</div>${sig('<div>Odai</div>')}`)).toBe(true);
		expect(hasWrittenContent(`<div><img src="data:image/png;base64,AA"></div>`)).toBe(true);
		expect(hasWrittenContent('')).toBe(false);
	});
});
