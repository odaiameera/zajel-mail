<script lang="ts">
	/**
	 * A text field for a settings row. It only holds the value: the page's
	 * Save bar is what stores it.
	 */
	let {
		value = $bindable(),
		placeholder,
		disabled = false,
		ariaLabel,
		maxlength,
		width = '220px'
	}: {
		value: string;
		placeholder?: string;
		disabled?: boolean;
		ariaLabel?: string;
		maxlength?: number;
		width?: string;
	} = $props();
</script>

<input
	type="text"
	bind:value
	placeholder={placeholder}
	aria-label={ariaLabel}
	disabled={disabled}
	maxlength={maxlength}
	class="bg-surface-hover border border-border rounded-lg px-2.5 py-1.5 text-sm text-text placeholder-text-tertiary outline-none focus:border-accent transition-colors disabled:opacity-50 max-w-full"
	style="width: {width};"
/>
