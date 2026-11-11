<script lang="ts">
	import { onMount, tick } from 'svelte';
	import Icon from '$lib/components/Icon.svelte';
	import MailboxIcon from '$lib/components/MailboxIcon.svelte';
	import type { IconNode } from '$lib/types/icon-node';

	/**
	 * Pick an icon for a folder or label from the whole Lucide set, by name
	 * or by what it's about (Lucide's own keywords: "money" finds banknote).
	 * The set loads when the picker first appears, not with the app.
	 */
	let {
		value,
		color,
		fallback,
		onPick
	}: {
		value: string | null;
		/** The chosen colour, or null for none. */
		color: string | null;
		fallback: 'folder' | 'dot';
		onPick: (name: string | null) => void;
	} = $props();

	// The likely ones for mail folders, first when nothing is searched.
	const SUGGESTED = [
		'folder', 'briefcase', 'receipt', 'banknote', 'credit-card', 'piggy-bank', 'landmark', 'shopping-cart',
		'plane', 'car', 'house', 'graduation-cap', 'book-open', 'newspaper', 'file-text', 'code',
		'users', 'heart', 'baby', 'dog', 'gift', 'star', 'bookmark', 'flag',
		'calendar', 'bell', 'tag', 'archive', 'mail', 'inbox', 'shield', 'key-round',
		'music', 'camera', 'gamepad-2', 'dumbbell', 'stethoscope', 'utensils', 'coffee', 'palette',
		'globe', 'lightbulb', 'rocket', 'trophy', 'wrench', 'hammer', 'leaf', 'sun'
	];
	const PAGE = 180;

	let nodes = $state.raw<Record<string, IconNode> | null>(null);
	let tags = $state.raw<Record<string, string[]>>({});
	let failed = $state(false);
	let query = $state('');
	let limit = $state(PAGE);
	let gridEl = $state<HTMLDivElement | undefined>();
	let sentinelEl = $state<HTMLDivElement | undefined>();

	onMount(async () => {
		try {
			const [n, t] = await Promise.all([
				import('lucide-static/icon-nodes.json'),
				import('lucide-static/tags.json')
			]);
			nodes = n.default as unknown as Record<string, IconNode>;
			tags = t.default as unknown as Record<string, string[]>;
		} catch {
			failed = true;
		}
	});

	const names = $derived.by(() => {
		if (!nodes) return [];
		const all = Object.keys(nodes);
		const q = query.trim().toLowerCase();
		if (!q) {
			// A folder's "No icon" already is the folder, so it isn't offered twice.
			const suggested = SUGGESTED.filter((n) => n in nodes! && !(fallback === 'folder' && n === 'folder'));
			const rest = all.filter((n) => !suggested.includes(n));
			return [...suggested, ...rest];
		}
		// Every word must match the name or one of its keywords; names that
		// start with the search come first, then names containing it, then
		// keyword matches.
		const words = q.split(/\s+/);
		const scored: [string, number][] = [];
		for (const name of all) {
			const keywords = tags[name] ?? [];
			let score = 0;
			let ok = true;
			for (const w of words) {
				if (name.startsWith(w)) score += 3;
				else if (name.includes(w)) score += 2;
				else if (keywords.some((k) => k.includes(w))) score += 1;
				else {
					ok = false;
					break;
				}
			}
			if (ok) scored.push([name, score]);
		}
		return scored.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([n]) => n);
	});

	// A new search starts from the top.
	$effect(() => {
		void query;
		limit = PAGE;
		void tick().then(() => gridEl?.scrollTo({ top: 0 }));
	});

	// Draw the set a page at a time as the grid scrolls; all 1,900 at once
	// would stall the dialog opening.
	$effect(() => {
		if (!sentinelEl || !gridEl) return;
		const io = new IntersectionObserver(
			(entries) => {
				if (entries.some((e) => e.isIntersecting)) limit += PAGE;
			},
			{ root: gridEl, rootMargin: '120px' }
		);
		io.observe(sentinelEl);
		return () => io.disconnect();
	});

	function cellClass(selected: boolean): string {
		return `h-9 grid place-items-center rounded-md cursor-pointer transition-colors ${
			selected ? 'bg-accent/15 ring-1 ring-accent/60' : 'text-text-secondary hover:bg-surface-hover hover:text-text'
		}`;
	}
</script>

<div class="space-y-2">
	<div class="relative">
		<Icon name="search" size={14} class="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-tertiary pointer-events-none" />
		<input
			type="search"
			bind:value={query}
			aria-label="Search icons"
			autocomplete="off"
			class="w-full h-8 pl-8 pr-3 rounded-lg bg-surface-hover border border-border focus:border-accent text-sm text-text outline-none"
		/>
	</div>

	<div
		bind:this={gridEl}
		class="h-44 overflow-y-auto rounded-lg border border-border bg-bg p-1.5"
		role="listbox"
		aria-label="Icons"
	>
		{#if failed}
			<p class="px-2 py-6 text-center text-xs text-danger">Icons couldn’t be loaded</p>
		{:else if !nodes}
			<div class="h-full grid place-items-center"><Icon name="loading" class="animate-spin text-text-tertiary" /></div>
		{:else}
			<div class="grid grid-cols-[repeat(auto-fill,minmax(2.25rem,1fr))] gap-1">
				{#if !query.trim()}
					<button
						type="button"
						role="option"
						aria-selected={value === null}
						aria-label="No icon"
						title="No icon"
						onclick={() => onPick(null)}
						class={cellClass(value === null)}
					>
						<MailboxIcon node={null} {fallback} color={value === null ? color : null} />
					</button>
				{/if}
				{#each names.slice(0, limit) as name (name)}
					<button
						type="button"
						role="option"
						aria-selected={value === name}
						aria-label={name}
						title={name}
						onclick={() => onPick(name)}
						class={cellClass(value === name)}
					>
						<MailboxIcon node={nodes[name]} fallback="folder" color={value === name ? color : null} />
					</button>
				{/each}
			</div>
			{#if names.length === 0}
				<p class="px-2 py-6 text-center text-xs text-text-tertiary">No icons match</p>
			{/if}
			{#if limit < names.length}
				<div bind:this={sentinelEl} class="h-4" aria-hidden="true"></div>
			{/if}
		{/if}
	</div>
</div>
