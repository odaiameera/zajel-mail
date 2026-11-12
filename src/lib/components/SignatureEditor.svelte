<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import { onDestroy } from 'svelte';
	import { Editor, Extension } from '@tiptap/core';
	import StarterKit from '@tiptap/starter-kit';
	import Link from '@tiptap/extension-link';
	import { TextStyle } from '@tiptap/extension-text-style';
	import FontFamily from '@tiptap/extension-font-family';
	import { BlockDirection, blockDirection } from '$lib/tiptap/block-direction';

	let {
		html = $bindable(''),
		disabled = false
	}: {
		html?: string;
		disabled?: boolean;
	} = $props();

	// Three Outlook-friendly faces. Cairo is loaded for the rest of the UI;
	// Helvetica Neue and Calibri fall back to system stacks if missing on a
	// recipient's mail client. The CSS value mirrors the option label so the
	// dropdown can show the active selection back.
	const FONT_OPTIONS = [
		{ label: 'Cairo',          value: "Cairo, sans-serif" },
		{ label: 'Helvetica Neue', value: "'Helvetica Neue', Helvetica, Arial, sans-serif" },
		{ label: 'Calibri',        value: "Calibri, 'Segoe UI', sans-serif" }
	];
	const SIZE_OPTIONS = ['10', '11', '12', '14', '16', '18'];
	const DEFAULT_SIZE = '12';

	// Tiptap doesn't ship a font-size mark — we add the attribute to TextStyle
	// so it serializes as `<span style="font-size: 14pt">`. Value pattern stays
	// inside the sanitizer's allowed regex (`/^\d+(\.\d+)?(pt|px)$/`).
	const FontSize = Extension.create({
		name: 'fontSize',
		addOptions() {
			return { types: ['textStyle'] as string[] };
		},
		addGlobalAttributes() {
			return [
				{
					types: this.options.types,
					attributes: {
						fontSize: {
							default: null,
							parseHTML: (el: HTMLElement) =>
								(el.style.fontSize ?? '').trim() || null,
							renderHTML: (attrs: { fontSize?: string | null }) =>
								attrs.fontSize ? { style: `font-size: ${attrs.fontSize}` } : {}
						}
					}
				}
			];
		}
	});

	let mountEl = $state<HTMLDivElement | undefined>();
	let editor: Editor | null = $state(null);
	let charCount = $state(0);

	// Track which marks are active so the toolbar buttons can show pressed
	// state. Bumped on every Tiptap transaction.
	let activeMarks = $state({ bold: false, italic: false, link: false, rtl: false });
	let activeFont = $state(FONT_OPTIONS[0].value);
	let activeSize = $state(DEFAULT_SIZE);

	onDestroy(() => editor?.destroy());

	$effect(() => {
		if (!mountEl || editor) return;
		editor = new Editor({
			element: mountEl,
			extensions: [
				StarterKit.configure({
					heading: false,
					bulletList: false,
					orderedList: false,
					listItem: false,
					blockquote: false,
					codeBlock: false,
					code: false,
					horizontalRule: false,
					strike: false,
					link: false
				}),
				Link.configure({ openOnClick: false, autolink: true }),
				TextStyle,
				FontFamily,
				FontSize,
				BlockDirection
			],
			content: html || '<p></p>',
			editable: !disabled,
			editorProps: {
				attributes: {
					class:
						'min-h-[120px] max-h-[280px] overflow-y-auto px-3 py-2 text-sm text-text outline-none signature-prose'
				}
			},
			onUpdate: ({ editor: e }) => {
				html = e.getHTML();
				charCount = e.getText().length;
				refreshActive();
			},
			// Every step, not only selection changes: switching direction is neither.
			onTransaction: () => refreshActive()
		});
		charCount = editor.getText().length;
		refreshActive();
	});

	// Keep editor's content in sync when the parent swaps signatures
	// (e.g. user clicks a different row in the list).
	$effect(() => {
		if (!editor) return;
		const current = editor.getHTML();
		if (html !== current) {
			editor.commands.setContent(html || '<p></p>', { emitUpdate: false });
			charCount = editor.getText().length;
			refreshActive();
		}
	});

	$effect(() => {
		if (!editor) return;
		if (editor.isEditable !== !disabled) {
			editor.setEditable(!disabled);
		}
	});

	function refreshActive() {
		if (!editor) return;
		activeMarks = {
			bold: editor.isActive('bold'),
			italic: editor.isActive('italic'),
			link: editor.isActive('link'),
			rtl: blockDirection(editor.state) === 'rtl'
		};
		const attrs = editor.getAttributes('textStyle') as {
			fontFamily?: string;
			fontSize?: string;
		};
		activeFont = matchFont(attrs.fontFamily) ?? FONT_OPTIONS[0].value;
		activeSize = matchSize(attrs.fontSize) ?? DEFAULT_SIZE;
	}

	function matchFont(value?: string): string | null {
		if (!value) return null;
		const normalized = value.replace(/\s+/g, ' ').trim();
		return FONT_OPTIONS.find((o) => o.value === normalized)?.value ?? null;
	}

	function matchSize(value?: string): string | null {
		if (!value) return null;
		const m = value.trim().match(/^(\d+(?:\.\d+)?)(pt|px)?$/);
		if (!m) return null;
		return SIZE_OPTIONS.includes(m[1]) ? m[1] : null;
	}

	function toggleBold() {
		editor?.chain().focus().toggleBold().run();
	}

	function toggleItalic() {
		editor?.chain().focus().toggleItalic().run();
	}

	function toggleDirection() {
		editor?.chain().focus().toggleBlockDirection().run();
	}

	function toggleLink() {
		if (!editor) return;
		if (editor.isActive('link')) {
			editor.chain().focus().unsetLink().run();
			return;
		}
		const url = window.prompt('Link URL', 'https://')?.trim();
		if (!url) return;
		// Tiptap's Link extension validates the scheme against allowedSchemes
		// (defaults: http, https, ftp, mailto). Anything weird is silently
		// dropped, so no extra guard needed here.
		const { from, to } = editor.state.selection;
		if (from === to) {
			editor.chain().focus().insertContent(`<a href="${escapeAttr(url)}">${escapeText(url)}</a>`).run();
		} else {
			editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
		}
	}

	function changeFont(e: Event) {
		const value = (e.target as HTMLSelectElement).value;
		if (!editor) return;
		editor.chain().focus().setFontFamily(value).run();
	}

	function changeSize(e: Event) {
		const value = (e.target as HTMLSelectElement).value;
		if (!editor) return;
		editor.chain().focus().setMark('textStyle', { fontSize: `${value}pt` }).run();
	}

	function escapeAttr(s: string): string {
		return s.replace(/"/g, '&quot;').replace(/</g, '&lt;');
	}

	function escapeText(s: string): string {
		return s.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]!);
	}

	const MAX_CHARS = 5000;
	const WARN_CHARS = 4500;
	const counterClass = $derived(
		charCount > MAX_CHARS
			? 'text-danger'
			: charCount > WARN_CHARS
				? 'text-warning'
				: 'text-text-tertiary'
	);
</script>

<div class="rounded-lg border border-border bg-surface-hover/40 overflow-hidden flex flex-col">
	<div class="flex items-center gap-1 px-2 py-1.5 border-b border-border bg-surface flex-wrap">
		<select
			value={activeFont}
			onchange={changeFont}
			disabled={disabled || !editor}
			aria-label="Font"
			title="Font"
			class="sig-select bg-surface-hover border border-border rounded-md px-1.5 py-1 text-xs text-text outline-none focus:border-accent transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed h-7 w-[120px] text-center"
		>
			{#each FONT_OPTIONS as opt (opt.value)}
				<option value={opt.value} style="font-family: {opt.value}">{opt.label}</option>
			{/each}
		</select>
		<select
			value={activeSize}
			onchange={changeSize}
			disabled={disabled || !editor}
			aria-label="Font size"
			title="Font size"
			class="sig-select bg-surface-hover border border-border rounded-md px-1.5 py-1 text-xs text-text outline-none focus:border-accent transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed h-7 w-[64px] text-center"
		>
			{#each SIZE_OPTIONS as size (size)}
				<option value={size}>{size} pt</option>
			{/each}
		</select>
		<div class="w-px h-5 bg-border mx-1"></div>
		<button
			type="button"
			onclick={toggleBold}
			disabled={disabled || !editor}
			aria-pressed={activeMarks.bold}
			aria-label="Bold"
			title="Bold (⌘B)"
			class="w-7 h-7 rounded-md flex items-center justify-center text-sm font-bold transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed
				{activeMarks.bold ? 'bg-accent/15 text-accent-fg' : 'text-text-secondary hover:bg-surface-hover hover:text-text'}"
		>
			B
		</button>
		<button
			type="button"
			onclick={toggleItalic}
			disabled={disabled || !editor}
			aria-pressed={activeMarks.italic}
			aria-label="Italic"
			title="Italic (⌘I)"
			class="w-7 h-7 rounded-md flex items-center justify-center text-sm italic transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed
				{activeMarks.italic ? 'bg-accent/15 text-accent-fg' : 'text-text-secondary hover:bg-surface-hover hover:text-text'}"
		>
			I
		</button>
		<button
			type="button"
			onclick={toggleLink}
			disabled={disabled || !editor}
			aria-pressed={activeMarks.link}
			aria-label={activeMarks.link ? 'Remove link' : 'Add link'}
			title={activeMarks.link ? 'Remove link' : 'Add link'}
			class="w-7 h-7 rounded-md flex items-center justify-center transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed
				{activeMarks.link ? 'bg-accent/15 text-accent-fg' : 'text-text-secondary hover:bg-surface-hover hover:text-text'}"
		>
			<Icon name="link" size={14} />
		</button>
		<button
			type="button"
			onclick={toggleDirection}
			disabled={disabled || !editor}
			aria-pressed={activeMarks.rtl}
			aria-label="Right to left"
			title="Right to left"
			class="w-7 h-7 rounded-md flex items-center justify-center transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed
				{activeMarks.rtl ? 'bg-accent/15 text-accent-fg' : 'text-text-secondary hover:bg-surface-hover hover:text-text'}"
		>
			<Icon name="direction-rtl" size={14} />
		</button>
		<div class="flex-1"></div>
		<span class="text-2xs {counterClass}" aria-live="polite">{charCount} / {MAX_CHARS}</span>
	</div>
	<div bind:this={mountEl}></div>
</div>

<style>
	/* Center the displayed value horizontally and vertically inside the
	   font / size <select>. WebKit and Firefox both honour text-align-last
	   on <select>; plain text-align is ignored on the closed control. */
	.sig-select {
		text-align: center;
		text-align-last: center;
		line-height: 1;
		padding-top: 0;
		padding-bottom: 0;
	}
	.sig-select option {
		text-align: left;
	}

	:global(.signature-prose p) {
		margin: 0 0 0.4em 0;
	}
	:global(.signature-prose p:last-child) {
		margin-bottom: 0;
	}
	:global(.signature-prose a) {
		color: var(--color-accent);
		text-decoration: underline;
	}
	:global(.signature-prose strong) {
		font-weight: 600;
	}
</style>
