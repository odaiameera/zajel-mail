<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import { onDestroy } from 'svelte';
	import { MailEditor } from '$lib/editor/mail-editor';
	import { incomingBody, signatureLines, textLength } from '$lib/editor/body-html';

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

	let mountEl = $state<HTMLDivElement | undefined>();
	let editor: MailEditor | null = $state(null);
	let charCount = $state(0);
	// The value of `html` the editor is showing: what it was last given, or
	// last wrote back. Anything else arriving in `html` is the parent
	// choosing another signature.
	let shown = '';

	// Which marks are on at the cursor, so the buttons can show as pressed.
	let activeMarks = $state({ bold: false, italic: false, link: false, rtl: false });
	let activeFont = $state(FONT_OPTIONS[0].value);
	let activeSize = $state(DEFAULT_SIZE);

	onDestroy(() => editor?.dispose());

	// A stored signature, ready for the editor: cleaned, and as lines (one
	// written in the old editor is a <p> per line).
	function forEditor(stored: string): string {
		return incomingBody(signatureLines(stored));
	}

	$effect(() => {
		if (!mountEl || editor) return;
		shown = html;
		// No default font or size: a line that sets neither takes the font of
		// the message the signature is put in.
		editor = new MailEditor(mountEl, {
			html: forEditor(html),
			handles: false,
			onChange: (next) => {
				shown = next;
				html = next;
				charCount = textLength(next);
			},
			onUpdate: refreshActive
		});
		editor.setEditable(!disabled);
		charCount = textLength(html);
		refreshActive();
	});

	// Keep the editor in step when the parent swaps signatures (another row
	// in the list, or the saved copy coming back from the server).
	$effect(() => {
		const next = html;
		if (!editor || next === shown) return;
		shown = next;
		editor.setHTML(forEditor(next));
		charCount = textLength(next);
		refreshActive();
	});

	$effect(() => {
		editor?.setEditable(!disabled);
	});

	function refreshActive() {
		if (!editor) return;
		const f = editor.format();
		activeMarks = { bold: f.bold, italic: f.italic, link: f.link, rtl: f.direction === 'rtl' };
		activeFont = matchFont(f.fontName ?? undefined) ?? FONT_OPTIONS[0].value;
		activeSize = matchSize(f.fontSize ?? undefined) ?? DEFAULT_SIZE;
	}

	// A font as the browser reports it back may have lost or changed its
	// quotes; compare the names alone.
	const fontKey = (value: string) => value.replace(/['"]/g, '').replace(/\s*,\s*/g, ',').replace(/\s+/g, ' ').trim().toLowerCase();

	function matchFont(value?: string): string | null {
		if (!value) return null;
		const key = fontKey(value);
		return FONT_OPTIONS.find((o) => fontKey(o.value) === key)?.value ?? null;
	}

	function matchSize(value?: string): string | null {
		if (!value) return null;
		const m = value.trim().match(/^(\d+(?:\.\d+)?)(pt|px)?$/);
		if (!m) return null;
		return SIZE_OPTIONS.includes(m[1]) ? m[1] : null;
	}

	function toggleBold() {
		editor?.toggleBold();
	}

	function toggleItalic() {
		editor?.toggleItalic();
	}

	function toggleDirection() {
		editor?.toggleDirection();
	}

	function toggleLink() {
		if (!editor) return;
		if (activeMarks.link) {
			editor.currentLink();
			editor.setLink(null);
			return;
		}
		const url = window.prompt('Link URL', 'https://')?.trim();
		// Only what a signature may link to; the server's cleaner holds the
		// same line.
		if (!url || !/^(https?:|mailto:)/i.test(url)) return;
		editor.setLink(url);
	}

	function changeFont(e: Event) {
		editor?.setFont((e.target as HTMLSelectElement).value);
	}

	function changeSize(e: Event) {
		editor?.setTextSize(`${(e.target as HTMLSelectElement).value}pt`);
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
	<!-- A press on a button here must not take the cursor out of the text: the
	     editor would have to put it back, and a format switched on for the
	     next letters (bold, on an empty line) is forgotten when it does. The
	     two menus are left alone; they need the press to open. -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="flex items-center gap-1 px-2 py-1.5 border-b border-border bg-surface flex-wrap"
		onmousedown={(e) => { if ((e.target as Element).closest('button')) e.preventDefault(); }}
	>
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
	<div
		bind:this={mountEl}
		dir="auto"
		class="mail-editor signature-editor min-h-[120px] max-h-[280px] overflow-y-auto px-3 py-2 text-sm text-text"
	></div>
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

	/* The signature as it will sit in a message: the app's text size, not the
	   composer's default, until a size is chosen for it. */
	.signature-editor {
		font-family: inherit;
		font-size: 0.875rem;
	}
</style>
