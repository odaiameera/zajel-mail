import { Extension } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

export type Direction = 'ltr' | 'rtl';

/** Where the text itself is: these take a direction of their own. */
const TEXT_BLOCKS = ['paragraph', 'heading'];
/** A list turns as a whole, so its bullets sit on the side its text starts. */
const LISTS = ['bulletList', 'orderedList'];
/**
 * Every node that keeps a `dir`. List items and quotes don't get one from
 * the toolbar, but keep what a reply or a reopened draft brings in. Not the
 * signature's wrapper: it is found by its bare `<div class="ameera-signature">`.
 */
const DIRECTED = [...TEXT_BLOCKS, ...LISTS, 'listItem', 'blockquote'];

/** `dir="rtl"`, Outlook's `dir=RTL`, or `style="direction: rtl"`; else none. */
function parseDirection(element: HTMLElement): Direction | null {
	const attr = element.getAttribute('dir')?.trim().toLowerCase();
	if (attr === 'rtl' || attr === 'ltr') return attr;
	const css = element.style.direction.trim().toLowerCase();
	return css === 'rtl' || css === 'ltr' ? css : null;
}

/** The direction at `pos`: the nearest `dir` at or above it, else left to right. */
function directionAt(doc: PMNode, pos: number): Direction {
	const $pos = doc.resolve(pos);
	for (let d = $pos.depth; d > 0; d--) {
		const dir = $pos.node(d).attrs.dir;
		if (dir === 'rtl' || dir === 'ltr') return dir;
	}
	return 'ltr';
}

/** The direction of the first line of text in the selection, as it shows. */
export function blockDirection(state: EditorState): Direction {
	const { from, to } = state.selection;
	let found: Direction | null = null;
	state.doc.nodesBetween(from, to, (node, pos) => {
		if (found) return false;
		if (!node.isTextblock) return true;
		found = directionAt(state.doc, pos + 1);
		return false;
	});
	return found ?? directionAt(state.doc, from);
}

type Target = 'block' | 'list';

/** What turns for the text from `from` to `to`: each paragraph, or the nearest list it's in. */
function directionTargets(doc: PMNode, from: number, to: number): Map<number, Target> {
	const targets = new Map<number, Target>();
	doc.nodesBetween(from, to, (node, pos) => {
		if (!node.isTextblock) return true;
		if (!TEXT_BLOCKS.includes(node.type.name)) return false;
		const $pos = doc.resolve(pos);
		let target: [number, Target] = [pos, 'block'];
		for (let d = $pos.depth; d > 0; d--) {
			if (LISTS.includes($pos.node(d).type.name)) {
				target = [$pos.before(d), 'list'];
				break;
			}
		}
		targets.set(...target);
		return false;
	});
	return targets;
}

/** Lay out the text from `from` to `to` in `direction`; false when there's none. */
function applyDirection(tr: Transaction, from: number, to: number, direction: Direction): boolean {
	const targets = directionTargets(tr.doc, from, to);
	// Outer blocks first, so what's inside sees their new direction.
	for (const [pos, kind] of [...targets].sort(([a], [b]) => a - b)) {
		const node = tr.doc.nodeAt(pos);
		if (!node) continue;
		// Said only where it differs from the surroundings (`pos` is just
		// outside the node, so this is what it would inherit).
		const dir = directionAt(tr.doc, pos) === direction ? null : direction;
		tr.setNodeMarkup(pos, undefined, { ...node.attrs, dir });
		if (kind === 'list') {
			// The whole list turns: nothing inside keeps a direction of its own.
			node.descendants((child, offset) => {
				if (child.attrs.dir) tr.setNodeMarkup(pos + 1 + offset, undefined, { ...child.attrs, dir: null });
				return !child.isTextblock;
			});
		}
	}
	return targets.size > 0;
}

const RTL_SCRIPT = /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}]/u;

/** The direction of the first letter in `text`; digits, spaces and punctuation say nothing. */
export function letterDirection(text: string): Direction | null {
	for (const ch of text) {
		if (/\p{L}/u.test(ch)) return RTL_SCRIPT.test(ch) ? 'rtl' : 'ltr';
	}
	return null;
}

/**
 * The direction a keystroke at `pos` should turn its line to, or null to
 * leave it. Only a line with no letters yet turns (or a list with none), so
 * an English word typed into an Arabic sentence doesn't flip the sentence,
 * while a line started with a number or a dash still follows its first word.
 */
function typedDirection(doc: PMNode, pos: number, text: string): Direction | null {
	const direction = letterDirection(text);
	if (!direction || directionAt(doc, pos) === direction) return null;
	const targets = directionTargets(doc, pos, pos);
	if (targets.size === 0) return null;
	for (const at of targets.keys()) if (letterDirection(doc.nodeAt(at)?.textContent ?? '')) return null;
	return direction;
}

/** The browser's own direction switches (a Mac's right-click Writing Direction, Ctrl+Shift on Windows). */
const DIRECTION_INPUTS = ['formatSetBlockTextDirection', 'formatSetInlineTextDirection'];

/** The direction in an input event's data: "rtl", or a declaration like "direction: rtl;". */
function dataDirection(data: string | null): Direction | null {
	const d = data?.toLowerCase() ?? '';
	return /\brtl\b/.test(d) ? 'rtl' : /\bltr\b/.test(d) ? 'ltr' : null;
}

/** Which way the browser is showing the first text in the selection right now. */
function domDirection(view: EditorView): Direction {
	const selection = view.dom.ownerDocument.getSelection();
	if (!selection?.rangeCount) return 'ltr';
	const range = selection.getRangeAt(0);
	// A selection of whole paragraphs, or of everything, starts on an element
	// (the paragraph, the editor) rather than in the text that was changed.
	let node: Node = range.startContainer;
	if (node.nodeType !== Node.TEXT_NODE) node = node.childNodes[range.startOffset] ?? node;
	while (node.firstChild) node = node.firstChild;
	const element = node instanceof Element ? node : node.parentElement;
	return element && getComputedStyle(element).direction === 'rtl' ? 'rtl' : 'ltr';
}

/**
 * Chrome may wrap the text in a `<span style="direction: …">` of its own.
 * ProseMirror keeps such a span as a text style with nothing set: drop it.
 */
function dropBareSpans(tr: Transaction): void {
	const textStyle = tr.doc.type.schema.marks.textStyle;
	if (!textStyle) return;
	const { from, to } = tr.selection;
	tr.doc.nodesBetween(from, to, (node, pos) => {
		if (!node.isText) return true;
		for (const mark of node.marks) {
			if (mark.type === textStyle && Object.values(mark.attrs).every((v) => !v)) {
				tr.removeMark(pos, pos + node.nodeSize, mark);
			}
		}
		return false;
	});
}

declare module '@tiptap/core' {
	interface Commands<ReturnType> {
		blockDirection: {
			/** Lay out the paragraphs in the selection (and the lists they're in) in this direction. */
			setBlockDirection: (direction: Direction) => ReturnType;
			/** Right to left if the selection starts left to right, and back. */
			toggleBlockDirection: () => ReturnType;
		};
	}
}

export interface BlockDirectionOptions {
	/**
	 * Turn a line with no text yet to the direction of the first letter typed
	 * into it. A page can't see the computer's keyboard language change, but
	 * the letters it types show it: switch to Arabic, start a line, and the
	 * line goes right to left.
	 */
	followKeyboard: boolean;
}

/**
 * Right-to-left and left-to-right paragraphs, kept as `dir` on the block so
 * the sent HTML carries it. Without this the schema had no place for a
 * direction: the browser's own direction switch was undone at once, and a
 * `dir` in a reply or a reopened draft was dropped on load.
 *
 * A block only says `dir` when it differs from what's around it, so a
 * left-to-right message stays as plain as before.
 */
export const BlockDirection = Extension.create<BlockDirectionOptions>({
	name: 'blockDirection',

	addOptions() {
		return { followKeyboard: true };
	},

	addGlobalAttributes() {
		return [
			{
				types: DIRECTED,
				attributes: {
					dir: {
						default: null,
						keepOnSplit: true,
						parseHTML: parseDirection,
						renderHTML: (attributes) => (attributes.dir ? { dir: attributes.dir } : {})
					}
				}
			}
		];
	},

	addCommands() {
		return {
			setBlockDirection:
				(direction) =>
				({ tr, dispatch }) => {
					const { from, to } = tr.selection;
					if (!dispatch) return directionTargets(tr.doc, from, to).size > 0;
					return applyDirection(tr, from, to, direction);
				},

			toggleBlockDirection:
				() =>
				({ state, commands }) =>
					commands.setBlockDirection(blockDirection(state) === 'rtl' ? 'ltr' : 'rtl')
		};
	},

	addProseMirrorPlugins() {
		const editor = this.editor;
		const followKeyboard = this.options.followKeyboard;
		return [
			new Plugin({
				key: new PluginKey('blockDirection'),
				props: {
					handleTextInput(view, from, to, text, deflt) {
						if (!followKeyboard) return false;
						const direction = typedDirection(view.state.doc, from, text);
						if (!direction) return false;
						// One step with the letter, so a single Undo takes both back.
						const tr = deflt ? deflt() : view.state.tr.insertText(text, from, to);
						applyDirection(tr, from, from, direction);
						view.dispatch(tr);
						return true;
					},
					handleDOMEvents: {
						// Safari asks first, and says which way: do it here instead.
						beforeinput(_view, event) {
							if (!DIRECTION_INPUTS.includes(event.inputType) || !event.data) return false;
							event.preventDefault();
							// "Default" arrives as `inherit`: left to right, like the rest.
							editor.commands.setBlockDirection(dataDirection(event.data) ?? 'ltr');
							return true;
						},
						// Chrome just does it, then says so. ProseMirror is about to put
						// its own DOM back, so read the browser's choice now and apply it
						// to the document once that's done.
						input(view, event) {
							const e = event as InputEvent;
							if (!DIRECTION_INPUTS.includes(e.inputType)) return false;
							const direction = dataDirection(e.data) ?? domDirection(view);
							setTimeout(() => {
								if (editor.isDestroyed) return;
								editor
									.chain()
									.setBlockDirection(direction)
									.command(({ tr }) => {
										dropBareSpans(tr);
										return true;
									})
									.run();
							});
							return false;
						}
					}
				}
			})
		];
	}
});
