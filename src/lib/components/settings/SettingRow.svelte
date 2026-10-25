<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import type { Snippet } from 'svelte';

	export type SaveState = 'idle' | 'saving' | 'saved' | 'error';

	let {
		title,
		description,
		state = 'idle',
		errorMessage,
		control
	}: {
		title: string;
		description?: string;
		state?: SaveState;
		errorMessage?: string;
		control: Snippet;
	} = $props();
</script>

<!-- A control too wide to sit beside its label (an input, a menu on a phone)
     wraps underneath it; toggles stay on the same line. -->
<div class="flex flex-wrap items-start gap-x-6 gap-y-3 py-4 border-b border-border last:border-b-0">
	<div class="flex-1 min-w-[12rem]">
		<p class="text-sm font-medium text-text">{title}</p>
		{#if description}
			<p class="text-xs text-text-tertiary mt-1">{description}</p>
		{/if}
		{#if state === 'error' && errorMessage}
			<p class="text-xs text-danger mt-1">{errorMessage}</p>
		{/if}
	</div>

	<div class="flex items-center gap-2 shrink-0">
		{#if state === 'saving'}
			<span class="text-2xs text-text-tertiary inline-flex items-center gap-1.5">
				<span class="w-3 h-3 rounded-full border-2 border-accent/40 border-t-accent animate-spin"></span>
				Saving…
			</span>
		{:else if state === 'saved'}
			<span class="text-2xs text-accent-fg inline-flex items-center gap-1">
				<Icon name="check" size={14} />
				Saved
			</span>
		{/if}
		{@render control()}
	</div>
</div>
