<script lang="ts">
	import type { Snippet } from 'svelte';

	/**
	 * One group of settings: a quiet label over a card whose rows are set
	 * apart by hairlines. The label says what the rows are, so they need no
	 * sentence each.
	 *
	 * `bare` leaves the card out, for a group that draws its own (the theme
	 * pictures, a form).
	 */
	let {
		title,
		id,
		headingId,
		action,
		bare = false,
		children
	}: {
		title?: string;
		/** The section's anchor: what the menu's search and links elsewhere land on. */
		id?: string;
		/** The heading's own id, where something already links to it by that name. */
		headingId?: string;
		/** A button for the group as a whole (New signature), at the end of the label's line. */
		action?: Snippet;
		bare?: boolean;
		children: Snippet;
	} = $props();

	const labelId = $derived(headingId ?? (id ? `${id}-heading` : undefined));
</script>

<section {id} class="mb-8 scroll-mt-6" aria-labelledby={title ? labelId : undefined}>
	{#if title || action}
		<div class="flex items-center justify-between gap-3 min-h-8 mb-1.5">
			{#if title}
				<!-- Focusable by script: a page sends focus here when what had it is gone. -->
				<h2 id={labelId} tabindex="-1" class="text-[0.8125rem] font-semibold text-text-tertiary outline-none">{title}</h2>
			{/if}
			{#if action}
				<div class="flex items-center gap-2 ml-auto">{@render action()}</div>
			{/if}
		</div>
	{/if}
	{#if bare}
		{@render children()}
	{:else}
		<div class="rounded-xl border border-border divide-y divide-border">
			{@render children()}
		</div>
	{/if}
</section>
