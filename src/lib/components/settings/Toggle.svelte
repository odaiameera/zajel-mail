<script lang="ts">
	/**
	 * Canonical toggle — iOS-style switch geometry.
	 *
	 * Uses inline-flex + padding + translate (NOT absolute positioning)
	 * so the knob sits inside the pill with visible 2px padding on all
	 * sides regardless of how the parent stretches. w-12 h-7 pill +
	 * w-6 h-6 knob is the iOS ratio — don't deviate.
	 */
	let {
		checked = false,
		onChange,
		disabled = false,
		ariaLabel
	}: {
		checked?: boolean;
		onChange?: (value: boolean) => void;
		disabled?: boolean;
		/** What the switch turns on and off, when the row beside it doesn't say. */
		ariaLabel?: string;
	} = $props();
</script>

<button
	type="button"
	role="switch"
	aria-checked={checked}
	aria-label={ariaLabel ?? (checked ? 'On' : 'Off')}
	disabled={disabled}
	onclick={() => onChange?.(!checked)}
	class="relative inline-flex items-center w-12 h-7 rounded-full p-0.5 shrink-0
		transition-colors duration-200 ease-out cursor-pointer
		disabled:opacity-50 disabled:cursor-not-allowed
		{checked ? 'bg-accent' : 'bg-text-tertiary/45'}"
>
	<span
		class="block w-6 h-6 rounded-full bg-white shadow-sm
			transition-transform duration-200 ease-out
			{checked ? 'translate-x-5' : 'translate-x-0'}"
	></span>
</button>
