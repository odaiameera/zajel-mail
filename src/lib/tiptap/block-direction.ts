import { Extension } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { EditorState } from '@tiptap/pm/state';

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

/**
 * Right-to-left and left-to-right paragraphs, kept as `dir` on the block so
 * the sent HTML carries it. Without this the schema had no place for a
 * direction: the browser's own direction switch was undone at once, and a
 * `dir` in a reply or a reopened draft was dropped on load.
 *
 * A block only says `dir` when it differs from what's around it, so a
 * left-to-right message stays as plain as before.
 */
export const BlockDirection = Extension.create({
	name: 'blockDirection',

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
				({ tr, state, dispatch }) => {
					const { from, to } = state.selection;
					// Each paragraph in the selection, or the nearest list it's in.
					const targets = new Map<number, 'block' | 'list'>();
					state.doc.nodesBetween(from, to, (node, pos) => {
						if (!node.isTextblock) return true;
						if (!TEXT_BLOCKS.includes(node.type.name)) return false;
						const $pos = state.doc.resolve(pos);
						let target: [number, 'block' | 'list'] = [pos, 'block'];
						for (let d = $pos.depth; d > 0; d--) {
							if (LISTS.includes($pos.node(d).type.name)) {
								target = [$pos.before(d), 'list'];
								break;
							}
						}
						targets.set(...target);
						return false;
					});
					if (targets.size === 0) return false;
					if (!dispatch) return true;

					// Outer blocks first, so what's inside sees their new direction.
					for (const [pos, kind] of [...targets].sort(([a], [b]) => a - b)) {
						const node = tr.doc.nodeAt(pos);
						if (!node) continue;
						// Said only where it differs from the surroundings (`pos` is
						// just outside the node, so this is what it would inherit).
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
					return true;
				},

			toggleBlockDirection:
				() =>
				({ state, commands }) =>
					commands.setBlockDirection(blockDirection(state) === 'rtl' ? 'ltr' : 'rtl')
		};
	}
});
