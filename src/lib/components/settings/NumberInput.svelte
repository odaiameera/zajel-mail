<script lang="ts">
	/**
	 * A number field for a settings row. The browser hands back a number, or
	 * null while the field is empty or holds something that isn't one, so the
	 * value is typed that way and the page decides what to say about a null.
	 */
	let {
		value = $bindable(),
		min,
		max,
		step = 1,
		disabled = false,
		ariaLabel,
		width = '110px'
	}: {
		value: number | null;
		min?: number;
		max?: number;
		step?: number;
		disabled?: boolean;
		ariaLabel?: string;
		width?: string;
	} = $props();
</script>

<input
	type="number"
	bind:value
	{min}
	{max}
	{step}
	aria-label={ariaLabel}
	disabled={disabled}
	class="h-8.5 bg-transparent border border-border rounded-md px-2.5 text-sm text-text outline-none focus:border-accent transition-colors disabled:opacity-50 max-w-full"
	style="width: {width};"
/>
