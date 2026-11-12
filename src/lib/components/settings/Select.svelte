<script lang="ts">
	let {
		value,
		options,
		onchange,
		disabled = false,
		ariaLabel
	}: {
		value: string;
		options: { value: string; label: string }[];
		onchange: (next: string) => void;
		disabled?: boolean;
		ariaLabel?: string;
	} = $props();

	// Room for the longest choice. The browser sizes a menu from its own
	// measure of the options, which comes out a few pixels short in this
	// typeface and cut the last letter off ("Contacts onl"); so the width
	// is said here, generously, and the value sits against the arrow.
	const longest = $derived(Math.max(0, ...options.map((o) => o.label.length)));
</script>

<select
	aria-label={ariaLabel}
	disabled={disabled}
	value={value}
	onchange={(e) => onchange((e.currentTarget as HTMLSelectElement).value)}
	style="min-width: calc({(longest * 0.62).toFixed(2)}em + 3.25rem)"
	class="h-8 max-w-full pl-2.5 -mr-2 bg-transparent border-0 rounded-md text-sm text-text [text-align-last:right] cursor-pointer hover:bg-surface-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
>
	{#each options as opt}
		<option value={opt.value}>{opt.label}</option>
	{/each}
</select>
