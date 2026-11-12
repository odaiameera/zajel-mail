<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import { parseSearch, type Token } from '$lib/search/parse';
	import SearchQuickFilters from './SearchQuickFilters.svelte';
	import { getRecentSearches, rememberSearch, clearRecentSearches } from '$lib/utils/recent-searches';
	import type { Mailbox } from '$lib/jmap/types';

	let {
		value = $bindable(''),
		onSubmit,
		placeholder = 'Search mail',
		mailboxes = []
	}: {
		value?: string;
		onSubmit: (raw: string) => void;
		placeholder?: string;
		mailboxes?: Mailbox[];
	} = $props();

	let panelOpen = $state(false);
	// ⌘K on Apple devices, Ctrl+K elsewhere. Filled in after load: the server
	// can't know the platform, and a guess would flash the wrong key.

	let inputEl = $state<HTMLInputElement | undefined>(undefined);
	let focused = $state(false);

	// Recent searches, loaded lazily when the panel needs them so we always
	// reflect the latest localStorage state without a subscription.
	let recents = $state<string[]>([]);

	function focusSearch() {
		inputEl?.focus();
		inputEl?.select();
	}

	/**
	 * Global shortcut: `/` or ⌘/Ctrl-K focuses search from anywhere, as long
	 * as the user isn't already typing into a field.
	 */
	function handleGlobalKeydown(e: KeyboardEvent) {
		const target = e.target as HTMLElement | null;
		const typing =
			!!target &&
			(target.tagName === 'INPUT' ||
				target.tagName === 'TEXTAREA' ||
				target.isContentEditable);

		if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
			e.preventDefault();
			focusSearch();
			return;
		}
		if (e.key === '/' && !typing) {
			e.preventDefault();
			focusSearch();
		}
	}

	function runRecent(q: string) {
		value = q;
		onSubmit(q);
		inputEl?.blur();
	}

	/**
	 * Keywords that should convert to an operator pill when the user types
	 * them followed by a space at a word boundary. Listed lowercase; input
	 * is compared case-insensitively so `From ` works too.
	 */
	const TRIGGER_KEYWORDS = new Set([
		'from', 'to', 'cc', 'subject', 'body',
		'before', 'after', 'in', 'label', 'tab'
	]);

	const tokens = $derived(parseSearch(value));

	/**
	 * When the autoquote path runs we remember the index of the opening
	 * quote so Tab/Enter can close the matching pair even if the user has
	 * moved the caret around in between.
	 */
	let pendingQuoteAt = $state<number | null>(null);

	function handleSubmit(e: Event) {
		e.preventDefault();
		const trimmed = value.trim();
		if (!trimmed) return;
		const finalized = closePendingQuote(trimmed);
		rememberSearch(finalized);
		onSubmit(finalized);
	}

	/**
	 * If the user opened an operator pill (`foo:"…`) but didn't close it,
	 * add the trailing quote before we finalize. Returns the potentially
	 * modified raw string; also clears the pending-quote state.
	 */
	function closePendingQuote(raw: string): string {
		if (pendingQuoteAt == null) return raw;
		const open = pendingQuoteAt;
		pendingQuoteAt = null;
		// If the user already typed the closing quote (or deleted the open
		// one), leave the string alone.
		const tail = raw.slice(open + 1);
		if (tail.includes('"') || raw[open] !== '"') return raw;
		return raw + '"';
	}

	function handleKeydown(e: KeyboardEvent) {
		if (!inputEl) return;

		if (e.key === 'Escape') {
			value = '';
			pendingQuoteAt = null;
			inputEl.blur();
			return;
		}

		if (e.key === 'Tab' && pendingQuoteAt != null) {
			const open = pendingQuoteAt;
			const tail = value.slice(open + 1);
			if (!tail.includes('"')) {
				e.preventDefault();
				const inserted = value + '" ';
				value = inserted;
				pendingQuoteAt = null;
				queueMicrotask(() => {
					inputEl?.setSelectionRange(inserted.length, inserted.length);
				});
				return;
			}
			pendingQuoteAt = null;
		}

		if (e.key === ' ') {
			const caret = inputEl.selectionStart;
			if (caret == null || caret !== inputEl.selectionEnd) return;
			// Only trigger when space lands at the very end of the input —
			// avoids surprising the user mid-string.
			if (caret !== value.length) return;
			// Word immediately to the left of the caret.
			const match = value.slice(0, caret).match(/(^|\s)([A-Za-z]+)$/);
			if (!match) return;
			const kw = match[2]!.toLowerCase();
			if (!TRIGGER_KEYWORDS.has(kw)) return;

			e.preventDefault();
			const wordStart = caret - match[2]!.length;
			const before = value.slice(0, wordStart);
			const after = value.slice(caret);
			const quoteAt = before.length + kw.length + 1; // position of the opening quote
			value = `${before}${kw}:"${after}`;
			pendingQuoteAt = quoteAt;
			queueMicrotask(() => {
				inputEl?.setSelectionRange(quoteAt + 1, quoteAt + 1);
			});
			return;
		}

		if (e.key === 'Backspace') {
			const caret = inputEl.selectionStart;
			if (caret == null || caret !== inputEl.selectionEnd) return;

			// If we're inside a pending auto-quote with the caret right
			// after the opening `"`, nuke the whole `kw:"` prefix so one
			// backspace undoes the trigger instead of just the quote.
			if (pendingQuoteAt != null && caret === pendingQuoteAt + 1) {
				const open = pendingQuoteAt;
				// Walk back to find the keyword start (`foo:"`).
				const prefix = value.slice(0, open);
				const km = prefix.match(/([A-Za-z]+):$/);
				if (km) {
					e.preventDefault();
					const start = open - km[1]!.length - 1;
					value = value.slice(0, start) + value.slice(open + 1);
					pendingQuoteAt = null;
					queueMicrotask(() => inputEl?.setSelectionRange(start, start));
					return;
				}
			}

			// Caret sits at the right edge of a recognized pill — eat the
			// whole pill in one keystroke.
			const t = tokens.find(
				(tok) => (tok.kind === 'field' || tok.kind === 'flag') && tok.end === caret
			);
			if (!t) return;
			e.preventDefault();
			const next = value.slice(0, t.start) + value.slice(t.end);
			value = next.replace(/\s{2,}/g, ' ').replace(/^\s+/, '');
			queueMicrotask(() => {
				inputEl?.setSelectionRange(t.start, t.start);
			});
		}
	}

	function handleBlur() {
		// Close an unfinalized auto-quote so the rendered pill is complete.
		if (pendingQuoteAt != null) {
			value = closePendingQuote(value);
		}
		setTimeout(() => (focused = false), 150);
	}

	function handleFocus() {
		focused = true;
		recents = getRecentSearches();
	}

	function handleFocusOut(e: FocusEvent) {
		const next = e.relatedTarget as Node | null;
		if (next && (e.currentTarget as HTMLElement).contains(next)) return;
		// Delay so clicks on panel buttons register before we teardown.
		setTimeout(() => (panelOpen = false), 150);
	}

	$effect(() => {
		// Panel opens whenever the field is focused: with content it shows the
		// quick filters; empty, it shows recent searches (if any).
		panelOpen = focused;
	});

	function pillClass(token: Token): string {
		if (token.kind === 'field') return 'bg-accent/15 text-accent-fg';
		if (token.kind === 'flag') return 'bg-success/15 text-success';
		if (token.kind === 'error') return 'bg-danger/15 text-danger';
		return '';
	}

	function pillLabel(token: Token): string {
		if (token.kind === 'field') return `${token.field}: ${token.value}`;
		if (token.kind === 'flag') return `${token.op}: ${token.value}`;
		if (token.kind === 'error') return token.raw;
		return token.raw;
	}
</script>

<svelte:window onkeydown={handleGlobalKeydown} />

<form onsubmit={handleSubmit} onfocusout={handleFocusOut} class="relative flex-1 min-w-0 md:min-w-[240px] max-w-[520px]">
	<div class="relative">
		<!-- Leading search glyph -->
		<span class="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary pointer-events-none">
			<Icon name="search" size={16} />
		</span>
		<!-- Underlay: rendered tokens. Mirrors the input's typography so the
		     pills sit where the text actually is. Hidden when the caret is
		     active so the user sees what they're typing without double-text. -->
		{#if !focused && tokens.length > 0}
			<div
				aria-hidden="true"
				class="absolute inset-y-0 left-0 right-3 flex items-center gap-1 pl-9 pr-1 pointer-events-none overflow-hidden whitespace-nowrap"
			>
				{#each tokens as t (t.start)}
					{#if t.kind === 'text'}
						<span class="text-sm text-text">{t.raw}</span>
					{:else}
						<span
							class="inline-flex items-center h-5 px-1.5 rounded-md text-2xs font-medium leading-none {pillClass(t)}"
							title={t.kind === 'error' ? t.reason : pillLabel(t)}
						>
							{pillLabel(t)}
						</span>
					{/if}
				{/each}
			</div>
		{/if}

		<input
			bind:this={inputEl}
			bind:value
			onfocus={handleFocus}
			onblur={handleBlur}
			onkeydown={handleKeydown}
			type="text"
			{placeholder}
			class="search-field w-full bg-bg/50 border border-border island-corners pl-9 pr-3 py-1.5 text-sm text-text placeholder-text-tertiary
				hover:border-text-tertiary/40 focus:bg-bg focus:border-accent/60 transition-colors duration-150
				{!focused && tokens.length > 0 ? 'text-transparent caret-text' : ''}"
		/>
	</div>

	{#if panelOpen}
		<div class="absolute top-full left-0 right-0 mt-1 bg-surface border border-border rounded-lg shadow-lg p-2 z-30">
			{#if value.trim().length === 0 && recents.length > 0}
				<div class="flex items-center justify-between px-1 pb-1.5">
					<span class="text-2xs uppercase tracking-wider text-text-tertiary">Recent searches</span>
					<button
						type="button"
						onmousedown={(e) => { e.preventDefault(); clearRecentSearches(); recents = []; }}
						class="text-2xs text-text-tertiary hover:text-text cursor-pointer"
					>
						Clear
					</button>
				</div>
				{#each recents as r}
					<button
						type="button"
						onmousedown={(e) => { e.preventDefault(); runRecent(r); }}
						class="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left text-sm text-text-secondary hover:bg-surface-hover hover:text-text cursor-pointer"
					>
						<Icon name="history" size={14} class="text-text-tertiary" />
						<span class="truncate">{r}</span>
					</button>
				{/each}
			{:else}
				<SearchQuickFilters {mailboxes} />
			{/if}
		</div>
	{/if}
</form>

<style>
	/* One focus state, the field's own: its border turns a quiet accent. The
	   app-wide keyboard outline (2px, offset) would otherwise ring it a second
	   time, much louder than any other field. Scoped, so it outranks that rule. */
	.search-field:focus-visible {
		outline: none;
	}
</style>
