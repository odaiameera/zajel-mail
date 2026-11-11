<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import { LABEL_COLORS, type LabelColor } from '$lib/constants/colors';

	let {
		value,
		onChange
	}: {
		/** null when no colour is chosen: none is shown selected. */
		value: LabelColor | null;
		onChange: (color: LabelColor) => void;
	} = $props();
</script>

<!-- w-max keeps the tracks content-sized: inside shrink-to-fit containers
     (popovers) 1fr tracks collapse under the fixed-size swatches and the
     circles overlap; in wide containers they over-spread. -->
<div class="grid w-max grid-cols-5 gap-2.5">
	{#each LABEL_COLORS as color (color.hex)}
		{@const selected = !!value && value.hex.toLowerCase() === color.hex.toLowerCase()}
		<button
			type="button"
			class="w-8 h-8 rounded-full flex items-center justify-center transition-transform hover:scale-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
			class:ring-2={selected}
			class:ring-offset-2={selected}
			class:ring-offset-surface={selected}
			style="background-color: {color.hex}; --tw-ring-color: {color.hex};"
			aria-label={color.name}
			aria-pressed={selected}
			title={color.name}
			onclick={() => onChange(color)}
		>
			{#if selected}
				<Icon name="check" size={16} class="text-white drop-shadow" />
			{/if}
		</button>
	{/each}
</div>
