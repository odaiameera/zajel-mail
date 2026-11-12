// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { BlockDirection, blockDirection } from './block-direction';
import { SignatureNode } from './signature-node';
import { applySignature } from '$lib/utils/signatures';

let editor: Editor | undefined;
afterEach(() => editor?.destroy());

function make(content: string): Editor {
	editor = new Editor({
		extensions: [StarterKit.configure({ link: false, underline: false, trailingNode: false }), SignatureNode, BlockDirection],
		content
	});
	return editor;
}

/** Put the cursor inside the first text block containing `text`. */
function cursorIn(e: Editor, text: string) {
	let at = -1;
	e.state.doc.descendants((node, pos) => {
		if (at < 0 && node.isTextblock && node.textContent.includes(text)) at = pos + 1;
		return at < 0;
	});
	expect(at).toBeGreaterThan(-1);
	e.commands.setTextSelection(at);
}

describe('block direction', () => {
	it('keeps the direction a reply or a reopened draft brings in', () => {
		const e = make(
			'<p dir="rtl">مرحبا</p><p dir=RTL>Outlook</p><p style="direction: rtl">styled</p><p dir="auto">auto</p>' +
				'<blockquote dir="rtl"><p>quoted</p></blockquote><ul dir="rtl"><li><p>item</p></li></ul>'
		);
		expect(e.getHTML()).toBe(
			'<p dir="rtl">مرحبا</p><p dir="rtl">Outlook</p><p dir="rtl">styled</p><p>auto</p>' +
				'<blockquote dir="rtl"><p>quoted</p></blockquote><ul dir="rtl"><li><p>item</p></li></ul>'
		);
	});

	it('leaves a left-to-right message as plain as before', () => {
		const e = make('<p>Hello</p><ul><li><p>one</p></li></ul>');
		expect(e.getHTML()).toBe('<p>Hello</p><ul><li><p>one</p></li></ul>');
	});

	it('switches the paragraph at the cursor, and back', () => {
		const e = make('<p>English</p><p>عربي</p>');
		cursorIn(e, 'عربي');
		expect(blockDirection(e.state)).toBe('ltr');
		e.commands.toggleBlockDirection();
		expect(e.getHTML()).toBe('<p>English</p><p dir="rtl">عربي</p>');
		expect(blockDirection(e.state)).toBe('rtl');
		e.commands.toggleBlockDirection();
		expect(e.getHTML()).toBe('<p>English</p><p>عربي</p>');
	});

	it('switches every paragraph in a selection, by the first one', () => {
		const e = make('<p>one</p><p dir="rtl">two</p><p>three</p>');
		e.commands.selectAll();
		e.commands.toggleBlockDirection();
		expect(e.getHTML()).toBe('<p dir="rtl">one</p><p dir="rtl">two</p><p dir="rtl">three</p>');
	});

	it('carries the direction to the next paragraph on Enter', () => {
		const e = make('<p>سطر</p>');
		cursorIn(e, 'سطر');
		e.commands.toggleBlockDirection();
		e.commands.setTextSelection(e.state.doc.content.size - 1);
		e.commands.splitBlock();
		e.commands.insertContent('ثاني');
		expect(e.getHTML()).toBe('<p dir="rtl">سطر</p><p dir="rtl">ثاني</p>');
	});

	it('turns a whole list, so its bullets move to the right with the text', () => {
		const e = make('<ul><li><p>one</p></li><li><p dir="ltr">two</p></li></ul>');
		cursorIn(e, 'one');
		e.commands.toggleBlockDirection();
		expect(e.getHTML()).toBe('<ul dir="rtl"><li><p>one</p></li><li><p>two</p></li></ul>');
		cursorIn(e, 'two');
		expect(blockDirection(e.state)).toBe('rtl');
		e.commands.toggleBlockDirection();
		expect(e.getHTML()).toBe('<ul><li><p>one</p></li><li><p>two</p></li></ul>');
	});

	it('says left to right outright inside a right-to-left quote', () => {
		const e = make('<blockquote dir="rtl"><p>نص</p><p>English</p></blockquote>');
		cursorIn(e, 'English');
		expect(blockDirection(e.state)).toBe('rtl');
		e.commands.toggleBlockDirection();
		expect(e.getHTML()).toBe('<blockquote dir="rtl"><p>نص</p><p dir="ltr">English</p></blockquote>');
	});

	it('never marks the signature wrapper, so a new signature still replaces it', () => {
		const e = make('<p>body</p><div class="ameera-signature"><p>-- Odai</p></div>');
		e.commands.selectAll();
		e.commands.toggleBlockDirection();
		const html = e.getHTML();
		expect(html).toContain('<div class="ameera-signature"><p dir="rtl">-- Odai</p></div>');
		expect(applySignature(html, '<p>-- New</p>')).toBe(
			'<p dir="rtl">body</p><p></p><div class="ameera-signature"><p>-- New</p></div>'
		);
	});
});
