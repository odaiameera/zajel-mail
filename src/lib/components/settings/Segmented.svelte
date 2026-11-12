<script lang="ts" generics="T extends string">
	/**
	 * A choice between two or three things, all of them on show. A longer
	 * list is a menu (Select).
	 *
	 * It is a radio group to a screen reader and the keyboard: one stop for
	 * Tab, the arrow keys to choose.
	 */
	let {
		value,
		options,
		onchange,
		ariaLabel,
		disabled = false
	}: {
		value: T;
		options: { value: T; label: string }[];
		onchange: (next: T) => void;
		ariaLabel: string;
		disabled?: boolean;
	} = $props();

	let group = $state<HTMLDivElement | null>(null);

	function onKeydown(e: KeyboardEvent) {
		const step =
			e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
		if (!step || disabled) return;
		e.preventDefault();
		const at = options.findIndex((o) => o.value === value);
		const to = (at + step + options.length) % options.length;
		if (options[to].value !== value) onchange(options[to].value);
		group?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[to]?.focus();
	}
</script>

<div
	bind:this={group}
	role="radiogroup"
	aria-label={ariaLabel}
	tabindex="-1"
	onkeydown={onKeydown}
	class="inline-flex gap-0.5 p-0.5 rounded-lg bg-surface-hover shrink-0 max-w-full"
>
	{#each options as option (option.value)}
		{@const on = option.value === value}
		<button
			type="button"
			role="radio"
			aria-checked={on}
			tabindex={on ? 0 : -1}
			{disabled}
			onclick={() => {
				if (!on) onchange(option.value);
			}}
			class="segment h-7 px-3 rounded-md text-[0.8125rem] font-medium whitespace-nowrap transition-colors cursor-pointer
				disabled:opacity-50 disabled:cursor-not-allowed
				{on ? 'on text-text' : 'text-text-secondary hover:text-text'}"
		>
			{option.label}
		</button>
	{/each}
</div>

<style>
	/* The chosen one is a raised chip: lighter than the track in the dark
	   theme, white on it in the light one. */
	.segment.on {
		background-color: #30363d;
		box-shadow: 0 1px 2px rgba(0, 0, 0, 0.4);
	}
	:global(html.light) .segment.on {
		background-color: #ffffff;
		box-shadow: 0 1px 2px rgba(31, 35, 40, 0.14);
	}
</style>
