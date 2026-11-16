import {
	AutoFormatPlugin,
	EditPlugin,
	Editor,
	ImageEditPlugin,
	PastePlugin,
	ShortcutPlugin,
	TableEditPlugin,
	adjustLinkSelection,
	clearFormat,
	createContentModelDocument,
	createDivider,
	createModelFromHtml,
	createParagraph,
	createText,
	editTable,
	exportContent,
	formatSegmentWithContentModel,
	getDarkColor,
	getFormatState,
	insertImage,
	insertLink,
	insertTable,
	iterateSelections,
	mergeModel,
	mutateBlock,
	redo,
	removeLink,
	setAlignment,
	setBackgroundColor,
	setDirection,
	setFontName,
	setFontSize,
	setIndentation,
	setTextColor,
	toggleBlockQuote,
	toggleBold,
	toggleBullet,
	toggleItalic,
	toggleNumbering,
	toggleStrikethrough,
	toggleSubscript,
	toggleSuperscript,
	toggleUnderline,
	undo,
	type ContentModelSegmentFormat,
	type EditorPlugin,
	type IEditor,
	type PluginEvent,
	type TableOperation
} from 'roosterjs';

/**
 * The message editor: Rooster, Microsoft's editor for mail on the web,
 * behind the few things the composer and the signature page ask of it.
 *
 * Rooster keeps the HTML it is given and writes one `<div>` per line with
 * its formatting inline, as Outlook and Gmail do, so a message reads the
 * same in the editor, in the Sent folder and in someone else's mail client.
 * It trusts what it is handed: give it only HTML that has been through
 * `incomingBody` (./body-html).
 */

export type Direction = 'ltr' | 'rtl';
export type Alignment = 'left' | 'center' | 'right';

/** What the toolbar shows as pressed or chosen, for the text at the cursor. */
export interface FormatFlags {
	bold: boolean;
	italic: boolean;
	underline: boolean;
	strike: boolean;
	bulletList: boolean;
	numberedList: boolean;
	quote: boolean;
	link: boolean;
	highlight: boolean;
	inTable: boolean;
	textColor: string | null;
	fontName: string | null;
	fontSize: string | null;
	align: Alignment | null;
	direction: Direction;
}

export const NO_FORMAT: FormatFlags = {
	bold: false,
	italic: false,
	underline: false,
	strike: false,
	bulletList: false,
	numberedList: false,
	quote: false,
	link: false,
	highlight: false,
	inTable: false,
	textColor: null,
	fontName: null,
	fontSize: null,
	align: null,
	direction: 'ltr'
};

export interface MailEditorOptions {
	/** The body to open with, already cleaned. */
	html: string;
	/**
	 * The font and size each new line is written in: the account's defaults,
	 * for a message. Left out (a signature), a line says neither and takes
	 * the font of the message it ends up in.
	 */
	fontFamily?: string;
	fontSize?: string;
	/** Called with the body's HTML after it changes (at most once a frame). */
	onChange?: (html: string) => void;
	/** Called when the content or the selection changes: time to redraw the toolbar. */
	onUpdate?: () => void;
	/**
	 * A picture pasted in. Return the address to show it from (a compressed
	 * data: URL, say), or null to leave it out. Without this, pasted pictures
	 * go in as the browser hands them over, at full size.
	 */
	onPasteImage?: (file: File) => Promise<string | null>;
	/** Offer table and picture handles (resize, add a row). Off for a small editor. */
	handles?: boolean;
}

/** The yellow of a highlighter pen, as Outlook's. */
const HIGHLIGHT = '#ffff00';

/** How light the dark theme's background is (HSL lightness), for converting a message's colours. */
const DARK_BACKGROUND_LIGHTNESS = 7;

function isDarkTheme(): boolean {
	return !document.documentElement.classList.contains('light');
}

export class MailEditor {
	private editor: IEditor;
	private element: HTMLDivElement;
	private options: MailEditorOptions;
	private defaultFormat: ContentModelSegmentFormat;
	private frame = 0;
	private silent = false;
	private cleanups: (() => void)[] = [];

	constructor(element: HTMLDivElement, options: MailEditorOptions) {
		this.element = element;
		this.options = options;
		// No colour: text takes the theme's while it is written and the
		// reader's default once it is sent. Rooster would otherwise read the
		// editor's own (light grey, in the dark theme) and write it into
		// every line, to arrive as pale text on a white page.
		this.defaultFormat = {
			...(options.fontFamily && { fontFamily: options.fontFamily }),
			...(options.fontSize && { fontSize: options.fontSize })
		};

		const events: EditorPlugin = {
			getName: () => 'MailEditorEvents',
			initialize: () => {},
			dispose: () => {},
			onPluginEvent: (event: PluginEvent) => this.onEvent(event)
		};

		const plugins: EditorPlugin[] = [
			new EditPlugin(),
			new PastePlugin(),
			new ShortcutPlugin(),
			new AutoFormatPlugin({
				autoBullet: true,
				autoNumbering: true,
				autoLink: true,
				autoUnlink: true,
				autoHyphen: true,
				// A line turns right to left when its first letter is Arabic or
				// Hebrew, and back for the next line started in English.
				autoDirection: true
			}),
			events
		];
		if (options.handles !== false) plugins.push(new TableEditPlugin(), new ImageEditPlugin());

		this.editor = new Editor(element, {
			plugins,
			initialModel: this.model(options.html),
			defaultSegmentFormat: this.defaultFormat,
			inDarkMode: isDarkTheme(),
			getDarkColor: (color: string) => getDarkColor(color, DARK_BACKGROUND_LIGHTNESS),
			// The editor's own text and background colours come from the app's
			// stylesheet, in both themes.
			doNotAdjustEditorColor: true
		});

		// Pictures pasted in, before Rooster takes them at full size. On the
		// parent, in the capture phase, so this is asked first.
		const host = element.parentElement ?? element;
		const onPaste = (e: ClipboardEvent) => void this.pasteImages(e);
		host.addEventListener('paste', onPaste, true);
		this.cleanups.push(() => host.removeEventListener('paste', onPaste, true));

		// The browser's own direction switch (a Mac's Writing Direction menu,
		// Ctrl+Shift on Windows). Safari asks first and says which way: do it
		// here. Chrome just does it, to the page, and Rooster reads the page.
		const onBeforeInput = (e: InputEvent) => {
			if (!/^formatSet(Block|Inline)TextDirection$/.test(e.inputType) || !e.data || !e.cancelable) return;
			e.preventDefault();
			this.setDirection(/\brtl\b/i.test(e.data) ? 'rtl' : 'ltr');
		};
		element.addEventListener('beforeinput', onBeforeInput);
		this.cleanups.push(() => element.removeEventListener('beforeinput', onBeforeInput));

		// The theme can change while a message is open (Settings > Appearance).
		const theme = new MutationObserver(() => {
			if (!this.editor.isDisposed() && this.editor.isDarkMode() !== isDarkTheme()) {
				this.editor.setDarkModeState(isDarkTheme());
			}
		});
		theme.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
		this.cleanups.push(() => theme.disconnect());
	}

	private model(html: string) {
		return createModelFromHtml(html || '<div><br></div>', undefined, undefined, this.defaultFormat);
	}

	private onEvent(event: PluginEvent): void {
		switch (event.eventType) {
			case 'contentChanged':
			case 'input':
			case 'compositionEnd':
				this.changed();
				break;
			case 'selectionChanged':
			case 'keyUp':
			case 'mouseUp':
			case 'editorReady':
				this.options.onUpdate?.();
				break;
		}
	}

	// Typing fires this per keystroke, and turning a long quoted message into
	// HTML is not free: once a frame is as often as anything can show it.
	private changed(): void {
		this.options.onUpdate?.();
		if (this.silent || !this.options.onChange || this.frame) return;
		this.frame = requestAnimationFrame(() => {
			this.frame = 0;
			if (!this.editor.isDisposed()) this.options.onChange?.(this.getHTML());
		});
	}

	private async pasteImages(e: ClipboardEvent): Promise<void> {
		const handler = this.options.onPasteImage;
		if (!handler || !this.element.contains(e.target as Node)) return;
		const items = Array.from(e.clipboardData?.items ?? []);
		// Text or HTML on the clipboard too (a copy from Word or a web page)
		// is Rooster's to paste; this is for a picture on its own.
		if (items.some((i) => i.kind === 'string' && /^text\/(html|plain)$/.test(i.type))) return;
		const files = items.filter((i) => i.type.startsWith('image/')).map((i) => i.getAsFile());
		if (files.length === 0) return;
		e.preventDefault();
		e.stopPropagation();
		for (const file of files) {
			if (!file) continue;
			const src = await handler(file);
			if (src && !this.editor.isDisposed()) this.insertImage(src);
		}
	}

	// --- Content ---

	/** The body as HTML, with a message's own colours (not the dark theme's versions of them). */
	getHTML(): string {
		return exportContent(this.editor);
	}

	/**
	 * Replace the whole body: another message, or the same one with a new
	 * signature. Says nothing through onChange: the caller knows what it set.
	 */
	setHTML(html: string): void {
		const next = this.model(html);
		this.silent = true;
		try {
			this.editor.formatContentModel(
				(model) => {
					model.blocks = next.blocks;
					return true;
				},
				{ apiName: 'setHTML' }
			);
			this.cursorToStart();
		} finally {
			this.silent = false;
		}
		this.options.onUpdate?.();
	}

	/** Whether the text can be edited (false while a save is in flight). */
	setEditable(editable: boolean): void {
		this.element.contentEditable = editable ? 'true' : 'false';
	}

	/** Put the cursor on the first line, where a reply is written. */
	cursorToStart(): void {
		let node: Node = this.element;
		while (node.firstChild) node = node.firstChild;
		const range = this.element.ownerDocument.createRange();
		if (node.nodeType === Node.TEXT_NODE) range.setStart(node, 0);
		else if (node !== this.element && node.parentNode) range.setStartBefore(node);
		else range.setStart(this.element, 0);
		range.collapse(true);
		// Placing the cursor takes the focus with it. Whoever had it keeps it
		// (the To field of a new message, the signature menu): the caller
		// says when the editor is where typing should go.
		const active = this.element.ownerDocument.activeElement as HTMLElement | null;
		const had = this.editor.hasFocus();
		this.editor.setDOMSelection({ type: 'range', range, isReverted: false });
		if (!had && active && active !== this.element && this.element.ownerDocument.activeElement === this.element) {
			if (active === this.element.ownerDocument.body) this.element.blur();
			else active.focus();
		}
	}

	focus(): void {
		this.editor.focus();
	}

	hasFocus(): boolean {
		return this.editor.hasFocus();
	}

	dispose(): void {
		if (this.frame) cancelAnimationFrame(this.frame);
		for (const cleanup of this.cleanups) cleanup();
		this.cleanups = [];
		if (!this.editor.isDisposed()) this.editor.dispose();
	}

	// --- What the toolbar shows ---

	format(): FormatFlags {
		if (this.editor.isDisposed()) return NO_FORMAT;
		const s = getFormatState(this.editor);
		const align = s.textAlign === 'center' ? 'center' : s.textAlign === 'right' || s.textAlign === 'end' ? 'right' : s.textAlign === 'left' || s.textAlign === 'start' ? 'left' : null;
		return {
			bold: !!s.isBold,
			italic: !!s.isItalic,
			underline: !!s.isUnderline,
			strike: !!s.isStrikeThrough,
			bulletList: !!s.isBullet,
			numberedList: !!s.isNumbering,
			quote: !!s.isBlockQuote,
			link: !!s.canUnlink,
			highlight: this.highlighted(),
			inTable: !!s.isInTable,
			textColor: s.textColor ?? null,
			fontName: s.fontName ?? null,
			fontSize: s.fontSize ?? null,
			align,
			direction: s.direction === 'rtl' ? 'rtl' : s.direction === 'ltr' ? 'ltr' : this.shownDirection()
		};
	}

	// Whether the text at the cursor is highlighted. Read from the text
	// itself: Rooster's own answer also counts the background behind the
	// editor, so the button showed as pressed on every line.
	private highlighted(): boolean {
		const colored = (value: string | undefined) => !!value && value !== 'transparent' && value !== 'rgba(0, 0, 0, 0)';
		// Switched on for the next letters, with nothing typed yet.
		const pending = this.editor.getPendingFormat();
		if (pending && 'backgroundColor' in pending) return colored(pending.backgroundColor);
		const selection = this.editor.getDOMSelection();
		const node = selection?.type === 'range' ? selection.range.startContainer : null;
		let element = node instanceof Element ? node : (node?.parentElement ?? null);
		for (; element && element !== this.element; element = element.parentElement) {
			// A highlight is on a run of text, not on the cell or block around it.
			if (!/^(SPAN|FONT|MARK|A|B|I|U|S|EM|STRONG|SUB|SUP)$/.test(element.tagName)) continue;
			if (colored((element as HTMLElement).style.backgroundColor)) return true;
		}
		return false;
	}

	// Which way the line at the cursor reads, as the browser lays it out: a
	// line that says nothing itself takes its direction from what is around it.
	private shownDirection(): Direction {
		const selection = this.editor.getDOMSelection();
		const node = selection?.type === 'range' ? selection.range.startContainer : null;
		const element = node instanceof Element ? node : (node?.parentElement ?? this.element);
		return getComputedStyle(element).direction === 'rtl' ? 'rtl' : 'ltr';
	}

	/**
	 * Where the selected text is on screen, or null when nothing is selected
	 * (or a picture or table cells are, which have handles of their own).
	 */
	selectionRect(): DOMRect | null {
		if (this.editor.isDisposed() || !this.editor.hasFocus()) return null;
		const selection = this.editor.getDOMSelection();
		if (selection?.type !== 'range' || selection.range.collapsed) return null;
		const rect = selection.range.getBoundingClientRect();
		return rect.width === 0 && rect.height === 0 ? null : rect;
	}

	// --- Formatting ---

	private run(command: (editor: IEditor) => void): void {
		if (this.editor.isDisposed()) return;
		this.editor.focus();
		command(this.editor);
		this.changed();
	}

	toggleBold = () => this.run(toggleBold);
	toggleItalic = () => this.run(toggleItalic);
	toggleUnderline = () => this.run(toggleUnderline);
	toggleStrike = () => this.run(toggleStrikethrough);
	toggleSubscript = () => this.run(toggleSubscript);
	toggleSuperscript = () => this.run(toggleSuperscript);
	toggleBulletList = () => this.run(toggleBullet);
	toggleNumberedList = () => this.run(toggleNumbering);
	toggleQuote = () => this.run((e) => toggleBlockQuote(e));
	clearFormatting = () => this.run(clearFormat);
	indent = () => this.run((e) => setIndentation(e, 'indent'));
	outdent = () => this.run((e) => setIndentation(e, 'outdent'));
	undo = () => this.run(undo);
	redo = () => this.run(redo);

	toggleHighlight = () =>
		this.run((e) =>
			this.format().highlight
				? // Said outright as "none", not just removed: at a bare cursor,
					// removing it leaves the next letters to take the highlight
					// of the text they land in.
					formatSegmentWithContentModel(e, 'clearHighlight', (format) => {
						format.backgroundColor = undefined;
					})
				: setBackgroundColor(e, HIGHLIGHT)
		);

	// Taking the text colour off. Rooster's own "set to nothing" removes it
	// from each selected piece of text, but it also keeps the colour on the
	// line as a whole (the <div>), which every piece without one of its own
	// then shows: the selected text stayed red, and so did whatever was typed
	// next. So the line lets go of it too. Text on the line that was not
	// selected holds its own copy of the colour and keeps it.
	private clearTextColor(): void {
		this.run((e) =>
			e.formatContentModel(
				(model, context) => {
					let changed = false;
					iterateSelections(model, (_path, _table, block, segments) => {
						if (block?.blockType !== 'Paragraph' || !segments) return false;
						const paragraph = mutateBlock(block);
						if (paragraph.segmentFormat?.textColor) delete paragraph.segmentFormat.textColor;
						for (const segment of segments) {
							const format = (segment as { format: ContentModelSegmentFormat }).format;
							delete format.textColor;
							// At a bare cursor: what is typed next has no colour either.
							if (segment.segmentType === 'SelectionMarker' && segments.length === 1) {
								context.newPendingFormat = { ...format, textColor: undefined };
							}
						}
						changed = true;
						return false;
					});
					return changed;
				},
				{ apiName: 'clearTextColor' }
			)
		);
	}

	/** A size such as "14pt", or null for the account's default. */
	setTextSize(size: string | null): void {
		this.run((e) => setFontSize(e, size ?? this.options.fontSize ?? '12pt'));
	}

	/** A CSS font stack. */
	setFont(fontFamily: string): void {
		this.run((e) => setFontName(e, fontFamily));
	}

	/** A colour, or null for none of its own. */
	setTextColor(color: string | null): void {
		if (color) this.run((e) => setTextColor(e, color));
		else this.clearTextColor();
	}

	setAlign(align: Alignment): void {
		this.run((e) => setAlignment(e, align));
	}

	setDirection(direction: Direction): void {
		this.run((e) => setDirection(e, direction));
	}

	toggleDirection(): void {
		this.setDirection(this.format().direction === 'rtl' ? 'ltr' : 'rtl');
	}

	// --- Links ---

	/** The address of the link at the cursor, selecting the whole link; '' when there is none. */
	currentLink(): string {
		if (this.editor.isDisposed()) return '';
		const [, url] = adjustLinkSelection(this.editor);
		return url ?? '';
	}

	/** Link the selection to `href`, or the address itself when nothing is selected; null removes the link. */
	setLink(href: string | null): void {
		this.run((e) => (href ? insertLink(e, href, undefined, undefined, '_blank') : removeLink(e)));
	}

	// --- Inserting ---

	insertText(text: string): void {
		this.run((e) =>
			e.formatContentModel(
				(model, context) => {
					const doc = createContentModelDocument();
					const paragraph = createParagraph(true);
					paragraph.segments.push(createText(text));
					doc.blocks.push(paragraph);
					mergeModel(model, doc, context, { mergeFormat: 'mergeAll' });
					return true;
				},
				{ apiName: 'insertText' }
			)
		);
	}

	insertDivider(): void {
		this.run((e) =>
			e.formatContentModel(
				(model, context) => {
					const doc = createContentModelDocument();
					doc.blocks.push(createDivider('hr'));
					mergeModel(model, doc, context);
					return true;
				},
				{ apiName: 'insertDivider' }
			)
		);
	}

	insertImage(src: string): void {
		this.run((e) => insertImage(e, src));
	}

	insertTable(columns: number, rows: number): void {
		this.run((e) => insertTable(e, columns, rows, { hasHeaderRow: true }));
	}

	tableOperation(operation: TableOperation): void {
		this.run((e) => editTable(e, operation));
	}
}
