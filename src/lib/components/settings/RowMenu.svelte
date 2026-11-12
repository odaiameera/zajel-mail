<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import { tick } from 'svelte';

	/**
	 * What can be done with a row, behind one button at its end, so the row
	 * itself stays a name. Built like MenuSelect's list: it hangs off
	 * <body>, against the button, and closes when the page scrolls.
	 */
	export interface RowMenuItem {
		label: string;
		onSelect: () => void;
		danger?: boolean;
		disabled?: boolean;
	}

	let { items, ariaLabel }: { items: RowMenuItem[]; ariaLabel: string } = $props();

	let open = $state(false);
	let triggerEl = $state<HTMLButtonElement | undefined>();
	let listEl = $state<HTMLDivElement | undefined>();
	let listStyle = $state('visibility: hidden');

	function portal(node: HTMLElement) {
		document.body.appendChild(node);
		return { destroy: () => node.remove() };
	}

	// Against the button's right edge, below it unless only above has room.
	$effect(() => {
		if (!open || !listEl || !triggerEl) return;
		const r = triggerEl.getBoundingClientRect();
		const h = listEl.offsetHeight;
		const below = window.innerHeight - r.bottom - 8;
		const up = below < h && r.top - 8 > below;
		const vertical = up ? `bottom: ${window.innerHeight - r.top + 4}px` : `top: ${r.bottom + 4}px`;
		listStyle = `${vertical}; right: ${Math.max(8, window.innerWidth - r.right)}px`;
		void tick().then(() => first()?.focus({ preventScroll: true }));
	});

	$effect(() => {
		if (!open) return;
		const onScroll = (e: Event) => {
			if (!listEl?.contains(e.target as Node)) open = false;
		};
		const onResize = () => (open = false);
		window.addEventListener('scroll', onScroll, true);
		window.addEventListener('resize', onResize);
		return () => {
			window.removeEventListener('scroll', onScroll, true);
			window.removeEventListener('resize', onResize);
		};
	});

	const buttons = () => [...(listEl?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
	const first = () => buttons()[0];

	function close() {
		open = false;
		triggerEl?.focus();
	}

	function choose(item: RowMenuItem) {
		close();
		item.onSelect();
	}

	function onListKeydown(e: KeyboardEvent) {
		const list = buttons();
		const at = list.indexOf(document.activeElement as HTMLButtonElement);
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			list[(at + 1) % list.length]?.focus();
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			list[(at - 1 + list.length) % list.length]?.focus();
		} else if (e.key === 'Escape' || e.key === 'Tab') {
			// Escape closes this menu only, not what is around it.
			e.preventDefault();
			e.stopPropagation();
			close();
		}
	}

	// A press anywhere else closes it. A click too: something worked without
	// a pointer (a screen reader's own "activate") sends no pointerdown, and
	// would otherwise leave this menu open beside the next one.
	function onWindowPress(e: Event) {
		const target = e.target as Node;
		if (open && !triggerEl?.contains(target) && !listEl?.contains(target)) open = false;
	}
</script>

<svelte:window onpointerdown={onWindowPress} onclick={onWindowPress} />

<button
	bind:this={triggerEl}
	type="button"
	aria-haspopup="menu"
	aria-expanded={open}
	aria-label={ariaLabel}
	onclick={() => {
		listStyle = 'visibility: hidden';
		open = !open;
	}}
	class="w-8 h-8 max-md:w-10 max-md:h-10 shrink-0 flex items-center justify-center rounded-md text-text-tertiary hover:text-text hover:bg-surface-hover transition-colors cursor-pointer {open ? 'bg-surface-hover text-text' : ''}"
>
	<Icon name="more" size={16} />
</button>

{#if open}
	<div
		bind:this={listEl}
		use:portal
		style={listStyle}
		role="menu"
		tabindex="-1"
		aria-label={ariaLabel}
		onkeydown={onListKeydown}
		class="fixed z-[100] min-w-40 max-w-[min(20rem,90vw)] py-1 rounded-lg border border-border bg-surface shadow-[0_8px_24px_rgba(0,0,0,0.35)] outline-none"
	>
		{#each items as item (item.label)}
			<button
				type="button"
				role="menuitem"
				disabled={item.disabled}
				onclick={() => choose(item)}
				class="w-full flex items-center px-3 py-1.5 text-sm text-left cursor-pointer hover:bg-surface-hover focus-visible:bg-surface-hover outline-none
					disabled:opacity-40 disabled:cursor-default disabled:hover:bg-transparent
					{item.danger ? 'text-danger' : 'text-text'}"
			>
				{item.label}
			</button>
		{/each}
	</div>
{/if}
