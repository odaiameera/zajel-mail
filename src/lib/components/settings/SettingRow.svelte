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

<!-- One row of a Section's card: the hairline between rows is the card's.
     A control too wide to sit beside its label (an input, a menu on a phone)
     wraps underneath it; toggles stay on the same line. A description is the
     exception: only where what the setting does can't be read off its name. -->
<div class="flex flex-wrap items-center gap-x-4 gap-y-2 min-h-14 px-5 py-2.5 max-md:px-4">
	<div class="flex-1 min-w-[9rem]">
		<p class="text-sm font-medium text-text">{title}</p>
		{#if description}
			<p class="text-[0.8125rem] text-text-tertiary mt-0.5">{description}</p>
		{/if}
		{#if state === 'error' && errorMessage}
			<p class="text-[0.8125rem] text-danger mt-0.5">{errorMessage}</p>
		{/if}
	</div>

	<div class="flex flex-wrap items-center justify-end gap-2 max-w-full">
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
