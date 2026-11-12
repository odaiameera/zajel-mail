<script lang="ts">
	/**
	 * Canonical toggle — a switch.
	 *
	 * Uses inline-flex + padding + translate (NOT absolute positioning)
	 * so the knob sits inside the pill with visible 2px padding on all
	 * sides regardless of how the parent stretches: a w-10 h-6 pill with
	 * a w-5 h-5 knob. Smaller than a finger, so the row around it gives
	 * the press its room (the invisible margin below).
	 *
	 * `size="sm"` (w-7 h-4 pill, w-3 h-3 knob) is for switches inside a
	 * list, such as rules under their folder; ordinary settings rows keep
	 * the full size.
	 */
	let {
		checked = false,
		onChange,
		disabled = false,
		ariaLabel,
		size = 'md'
	}: {
		checked?: boolean;
		onChange?: (value: boolean) => void;
		disabled?: boolean;
		/** What the switch turns on and off, when the row beside it doesn't say. */
		ariaLabel?: string;
		size?: 'md' | 'sm';
	} = $props();
</script>

<button
	type="button"
	role="switch"
	aria-checked={checked}
	aria-label={ariaLabel ?? (checked ? 'On' : 'Off')}
	disabled={disabled}
	onclick={() => onChange?.(!checked)}
	class="relative inline-flex items-center rounded-full p-0.5 shrink-0
		{size === 'sm' ? 'w-7 h-4' : 'w-10 h-6 before:absolute before:-inset-2.5'}
		transition-colors duration-200 ease-out cursor-pointer
		disabled:opacity-50 disabled:cursor-not-allowed
		{checked ? 'bg-accent' : 'bg-text-tertiary/45'}"
>
	<span
		class="block rounded-full bg-white shadow-sm
			transition-transform duration-200 ease-out
			{size === 'sm' ? 'w-3 h-3' : 'w-5 h-5'}
			{checked ? (size === 'sm' ? 'translate-x-3' : 'translate-x-4') : 'translate-x-0'}"
	></span>
</button>
