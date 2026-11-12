// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { BlockDirection, blockDirection, letterDirection } from './block-direction';
import { SignatureNode } from './signature-node';
import { applySignature } from '$lib/utils/signatures';

let editor: Editor | undefined;
afterEach(() => editor?.destroy());

function make(content: string, followKeyboard = true): Editor {
	editor = new Editor({
		extensions: [
			StarterKit.configure({ link: false, underline: false, trailingNode: false }),
			SignatureNode,
			BlockDirection.configure({ followKeyboard })
		],
		content
	});
	return editor;
}

/** Type `text` at the selection the way ProseMirror does for a keystroke. */
function type(e: Editor, text: string) {
	for (const ch of text) {
		const { from, to } = e.state.selection;
		const deflt = () => e.state.tr.insertText(ch, from, to);
		if (!e.view.someProp('handleTextInput', (f) => f(e.view, from, to, ch, deflt))) e.view.dispatch(deflt());
	}
}

function endOf(e: Editor, text: string) {
	cursorIn(e, text);
	const { $from } = e.state.selection;
	e.commands.setTextSelection($from.end());
}

function directionEvent(type: 'beforeinput' | 'input', data: string | null) {
	return new InputEvent(type, { inputType: 'formatSetBlockTextDirection', data, bubbles: true, cancelable: true });
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

describe('following the keyboard language', () => {
	it('reads a letter’s direction, and nothing from digits or punctuation', () => {
		expect(letterDirection('ب')).toBe('rtl');
		expect(letterDirection('שלום')).toBe('rtl');
		expect(letterDirection('a')).toBe('ltr');
		expect(letterDirection('١٢ - 3. ب')).toBe('rtl');
		expect(letterDirection('12 - .')).toBeNull();
	});

	it('turns a new line right to left when its first letter is Arabic', () => {
		const e = make('<p>Hello</p><p></p>');
		e.commands.setTextSelection(e.state.doc.content.size - 1);
		type(e, 'مرحبا');
		expect(e.getHTML()).toBe('<p>Hello</p><p dir="rtl">مرحبا</p>');
	});

	it('turns back when the next line starts in English', () => {
		const e = make('<p dir="rtl">عربي</p>');
		endOf(e, 'عربي');
		e.commands.splitBlock();
		type(e, 'Hi');
		expect(e.getHTML()).toBe('<p dir="rtl">عربي</p><p>Hi</p>');
	});

	it('leaves a line that already has words, so an English word can sit in Arabic', () => {
		const e = make('<p dir="rtl">اسم المنتج</p>');
		endOf(e, 'اسم');
		type(e, ' Zajel');
		expect(e.getHTML()).toBe('<p dir="rtl">اسم المنتج Zajel</p>');
	});

	it('goes by the first letter of a line started with a number or a dash', () => {
		const e = make('<p></p>');
		e.commands.setTextSelection(1);
		type(e, '1- بند');
		expect(e.getHTML()).toBe('<p dir="rtl">1- بند</p>');
	});

	it('turns a list only while it has no words', () => {
		const e = make('<ul><li><p></p></li></ul>');
		e.commands.setTextSelection(3);
		type(e, 'أ');
		expect(e.getHTML()).toBe('<ul dir="rtl"><li><p>أ</p></li></ul>');
		endOf(e, 'أ');
		e.commands.splitListItem('listItem');
		type(e, 'B');
		expect(e.getHTML()).toBe('<ul dir="rtl"><li><p>أ</p></li><li><p>B</p></li></ul>');
	});

	it('undoes the letter and the turn together', () => {
		const e = make('<p></p>');
		e.commands.setTextSelection(1);
		type(e, 'ب');
		e.commands.undo();
		expect(e.getHTML()).toBe('<p></p>');
	});

	it('can be left off', () => {
		const e = make('<p></p>', false);
		e.commands.setTextSelection(1);
		type(e, 'ب');
		expect(e.getHTML()).toBe('<p>ب</p>');
	});
});

describe('the browser’s own direction switch', () => {
	it('does what Safari asks, instead of letting it change the page', () => {
		const e = make('<p>نص</p>');
		cursorIn(e, 'نص');
		const event = directionEvent('beforeinput', 'rtl');
		e.view.dom.dispatchEvent(event);
		expect(event.defaultPrevented).toBe(true);
		expect(e.getHTML()).toBe('<p dir="rtl">نص</p>');
		// Its Default is left to right, like the rest of the message.
		e.view.dom.dispatchEvent(directionEvent('beforeinput', 'inherit'));
		expect(e.getHTML()).toBe('<p>نص</p>');
	});

	it('keeps what Chrome did, once ProseMirror has put its DOM back', async () => {
		const e = make('<p>نص</p>');
		cursorIn(e, 'نص');
		e.view.dom.dispatchEvent(directionEvent('input', 'direction: rtl;'));
		await new Promise((resolve) => setTimeout(resolve));
		expect(e.getHTML()).toBe('<p dir="rtl">نص</p>');
	});

	it('leaves other input alone', () => {
		const e = make('<p>text</p>');
		cursorIn(e, 'text');
		const event = new InputEvent('beforeinput', { inputType: 'formatBold', bubbles: true, cancelable: true });
		e.view.dom.dispatchEvent(event);
		expect(event.defaultPrevented).toBe(false);
	});
});

