<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import { onMount } from 'svelte';
	import { getRecentRecipients, isValidEmail } from '$lib/utils/recent-recipients';
	import { addressBook, loadAddressBook } from '$lib/stores/addressBook';
	import { nameForAddress, suggestRecipients, type Suggestion } from '$lib/contacts/directory';

	let {
		value = $bindable(''),
		label,
		autofocus = false
	}: {
		value?: string;
		label: string;
		autofocus?: boolean;
	} = $props();

	let draft = $state('');
	let inputEl = $state<HTMLInputElement | undefined>();
	let highlight = $state(0);
	let focused = $state(false);

	onMount(() => void loadAddressBook());

	// Committed chips are derived from the comma-joined `value` so the store
	// stays the single source of truth (endpoints still receive a plain string).
	const chips = $derived(
		value
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean)
	);

	function setChips(next: string[]) {
		// De-dupe case-insensitively, preserve order.
		const seen = new Set<string>();
		const out: string[] = [];
		for (const c of next) {
			const k = c.toLowerCase();
			if (!c || seen.has(k)) continue;
			seen.add(k);
			out.push(c);
		}
		value = out.join(', ');
	}

	function commitDraft() {
		const t = draft.trim().replace(/,$/, '').trim();
		if (!t) {
			draft = '';
			return;
		}
		setChips([...chips, t]);
		draft = '';
	}

	function removeChip(i: number) {
		setChips(chips.filter((_, idx) => idx !== i));
		inputEl?.focus();
	}

	// Contacts and contact lists by name or address, then recent addresses.
	const suggestions = $derived(
		suggestRecipients(
			$addressBook,
			draft,
			new Set(chips.map((c) => c.toLowerCase())),
			getRecentRecipients()
		)
	);

	$effect(() => {
		void suggestions;
		highlight = 0;
	});

	function pick(s: Suggestion) {
		// A list adds everyone in it.
		setChips([...chips, ...(s.kind === 'list' ? s.emails : [s.email])]);
		draft = '';
		inputEl?.focus();
	}

	function handleKeydown(e: KeyboardEvent) {
		if (suggestions.length > 0 && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
			e.preventDefault();
			const dir = e.key === 'ArrowDown' ? 1 : -1;
			highlight = (highlight + dir + suggestions.length) % suggestions.length;
			return;
		}
		if (e.key === 'Escape' && suggestions.length > 0 && draft) {
			e.stopPropagation();
			draft = '';
			return;
		}
		if (e.key === 'Enter' || e.key === ',' || e.key === 'Tab' || e.key === ';') {
			if (e.key === 'Tab' && !draft.trim()) return; // let Tab move focus normally
			if (e.key !== ',' && e.key !== ';' && suggestions[highlight]) {
				e.preventDefault();
				pick(suggestions[highlight]);
				return;
			}
			if (draft.trim()) {
				e.preventDefault();
				commitDraft();
			}
			return;
		}
		if (e.key === 'Backspace' && !draft && chips.length > 0) {
			e.preventDefault();
			removeChip(chips.length - 1);
		}
	}

	// Pasting "a@x.test, b@y.test" adds each address as its own chip.
	function handlePaste(e: ClipboardEvent) {
		const text = e.clipboardData?.getData('text') ?? '';
		if (!/[,;\n]/.test(text)) return;
		e.preventDefault();
		setChips([...chips, ...text.split(/[,;\n]/).map((s) => s.trim()).filter(Boolean)]);
	}

	function handleBlur() {
		commitDraft();
		focused = false;
	}
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="flex items-start pl-3 pr-14 py-1.5 border-b border-border/50 cursor-text" onclick={() => inputEl?.focus()}>
	<span class="text-xs text-text-tertiary w-12 shrink-0 pt-1">{label}</span>
	<div class="relative flex-1 min-w-0">
		<div class="flex flex-wrap items-center gap-1">
			{#each chips as chip, i (chip + i)}
				{@const valid = isValidEmail(chip)}
				{@const name = nameForAddress($addressBook, chip)}
				<span
					class="inline-flex items-center gap-1 h-6 pl-2 pr-1 rounded-full text-xs max-w-full
						{valid
						? 'bg-surface-hover text-text border border-border'
						: 'bg-danger/10 text-danger border border-danger/40'}"
					title={valid ? chip : `${chip} isn't a valid address`}
				>
					<span class="truncate">{name || chip}</span>
					<button
						type="button"
						onclick={(e) => { e.stopPropagation(); removeChip(i); }}
						class="shrink-0 w-4 h-4 grid place-items-center rounded-full text-text-tertiary hover:text-text hover:bg-border cursor-pointer"
						aria-label={`Remove ${chip}`}
					>
						<Icon name="close" size={12} />
					</button>
				</span>
			{/each}
			<input
				bind:this={inputEl}
				bind:value={draft}
				onkeydown={handleKeydown}
				onpaste={handlePaste}
				onfocus={() => { focused = true; void loadAddressBook(); }}
				onblur={handleBlur}
				type="text"
				aria-label={label}
				autocomplete="off"
				{autofocus}
				class="flex-1 min-w-[8ch] h-6 bg-transparent text-sm text-text outline-none focus-visible:outline-none!"
			/>
		</div>

		{#if focused && suggestions.length > 0}
			<ul
				role="listbox"
				aria-label="{label} suggestions"
				class="absolute top-full left-0 mt-1 w-full max-w-sm bg-surface border border-border rounded-lg shadow-[0_8px_24px_rgba(0,0,0,0.35)] z-50 py-1"
			>
				{#each suggestions as s, i (s.kind === 'list' ? `l:${s.id}` : `p:${s.email}`)}
					<li
						role="option"
						aria-selected={i === highlight}
						onmousedown={(e) => { e.preventDefault(); pick(s); }}
						onpointermove={() => (highlight = i)}
						class="flex items-center gap-2.5 px-3 py-1.5 text-sm cursor-pointer {i === highlight ? 'bg-surface-hover' : ''}"
					>
						{#if s.kind === 'list'}
							<span class="w-6 h-6 shrink-0 rounded-full bg-accent/15 text-accent-fg grid place-items-center" aria-hidden="true">
								<Icon name="group" size={14} />
							</span>
							<span class="truncate text-text">{s.name}</span>
							<span class="shrink-0 text-xs text-text-tertiary">{s.emails.length} {s.emails.length === 1 ? 'person' : 'people'}</span>
						{:else}
							<span class="w-6 h-6 shrink-0 rounded-full bg-surface-hover text-text-secondary grid place-items-center text-2xs font-semibold" aria-hidden="true">
								{(s.name || s.email).slice(0, 1).toUpperCase()}
							</span>
							{#if s.name}
								<span class="truncate text-text">{s.name}</span>
								<span class="truncate text-xs text-text-tertiary">{s.email}</span>
							{:else}
								<span class="truncate text-text">{s.email}</span>
							{/if}
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</div>
</div>
