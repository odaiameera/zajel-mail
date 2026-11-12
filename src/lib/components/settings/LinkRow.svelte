<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';

	/**
	 * A row that opens something of its own (Signatures, Out of office): its
	 * name, what it is set to in a word or a count, and a chevron.
	 */
	let { title, href, value }: { title: string; href: string; value?: string | number } = $props();
</script>

<a
	{href}
	class="flex items-center gap-4 min-h-14 px-5 py-2.5 max-md:px-4 text-sm first:rounded-t-xl last:rounded-b-xl
		hover:bg-surface-hover transition-colors"
>
	<span class="flex-1 min-w-0 font-medium text-text">{title}</span>
	{#if value !== undefined && value !== ''}
		<span class="text-text-tertiary">{value}</span>
	{/if}
	<Icon name="next" size={16} class="text-text-tertiary -mr-1" />
</a>
