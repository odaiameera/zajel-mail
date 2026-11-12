<script lang="ts">
	import type { Snippet } from 'svelte';

	/**
	 * A settings page's title. Just the name: what the page is for is said
	 * by its sections. `actions` are the page's own buttons (New folder),
	 * at the end of the title's line.
	 */
	let { title, actions }: { title: string; actions?: Snippet } = $props();
</script>

<header class="mb-8 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
	<h1 tabindex="-1" class="text-[1.75rem] leading-9 font-semibold tracking-tight text-text outline-none">{title}</h1>
	{#if actions}
		<div class="flex items-center gap-2">{@render actions()}</div>
	{/if}
</header>
