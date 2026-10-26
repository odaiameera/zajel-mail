<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import Icon from '$lib/components/Icon.svelte';
	import type { IconName } from '$lib/icons';
	import { composer, openCompose, requestCloseCompose } from '$lib/stores/compose';
	import { newRequest, type NewKind } from '$lib/stores/create';

	/**
	 * The two things you can start from anywhere, in the bottom-right corner:
	 * + (a new message, event or contact) and Zajel, the AI mail agent. Their
	 * windows open above them. While a message is being written, + is × and
	 * closes it (saved as a draft if it has anything in it).
	 */
	let {
		assistantOpen,
		onToggleAssistant,
		/** Phones: an open message, where a floating button would cover the text. */
		readingOnPhone = false
	}: {
		assistantOpen: boolean;
		onToggleAssistant: () => void;
		readingOnPhone?: boolean;
	} = $props();

	const ITEMS: { kind: 'message' | NewKind; label: string; icon: IconName }[] = [
		{ kind: 'message', label: 'Message', icon: 'compose' },
		{ kind: 'event', label: 'Event', icon: 'calendar' },
		{ kind: 'contact', label: 'Contact', icon: 'contacts' }
	];

	let menuOpen = $state(false);
	const composing = $derived($composer.mode !== 'closed');

	function onPlus() {
		if (composing) {
			menuOpen = false;
			requestCloseCompose();
			return;
		}
		menuOpen = !menuOpen;
	}

	function create(kind: 'message' | NewKind) {
		menuOpen = false;
		if (kind === 'message') {
			openCompose();
			return;
		}
		newRequest.set(kind);
		const home = kind === 'event' ? '/calendar' : '/contacts';
		if (!page.url.pathname.startsWith(home)) void goto(home);
	}

	function onWindowPointerDown(e: PointerEvent) {
		if (menuOpen && !(e.target as Element | null)?.closest('[data-corner-actions]')) menuOpen = false;
	}

	function onWindowKeydown(e: KeyboardEvent) {
		if (menuOpen && e.key === 'Escape') {
			e.stopPropagation();
			menuOpen = false;
		}
	}
</script>

<svelte:window onpointerdown={onWindowPointerDown} onkeydown={onWindowKeydown} />

<div
	data-corner-actions
	class="fixed z-[36] flex items-center gap-2.5
		md:right-[68px] md:bottom-[calc(1.25rem-var(--app-under))]
		max-md:right-4 max-md:bottom-[calc(6.5rem+env(safe-area-inset-bottom)-var(--app-under))]
		{readingOnPhone ? 'max-md:hidden' : ''}"
>
	<div class="relative">
		{#if menuOpen}
			<div
				role="menu"
				aria-label="New"
				class="new-menu absolute bottom-full right-0 mb-2 w-44 py-1 rounded-lg border border-border bg-surface shadow-[0_8px_24px_rgba(0,0,0,0.35)] origin-bottom-right"
			>
				{#each ITEMS as item (item.kind)}
					<button
						type="button"
						role="menuitem"
						onclick={() => create(item.kind)}
						class="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-text text-left hover:bg-surface-hover cursor-pointer"
					>
						<Icon name={item.icon} class="text-text-secondary" />
						{item.label}
					</button>
				{/each}
			</div>
		{/if}
		<button
			type="button"
			onclick={onPlus}
			class="h-12 w-12 grid place-items-center rounded-full bg-accent hover:bg-accent-hover text-white shadow-[0_8px_24px_rgba(0,0,0,0.35)] cursor-pointer transition-colors"
			aria-label={composing ? 'Close message' : 'New'}
			title={composing ? 'Close message' : 'New'}
			aria-haspopup={composing ? undefined : 'menu'}
			aria-expanded={composing ? undefined : menuOpen}
		>
			<!-- + turns an eighth of a turn into × while its menu is open. -->
			<Icon name={composing ? 'close' : 'add'} size={20} class="transition-transform duration-200 {menuOpen ? 'rotate-45' : ''}" />
		</button>
	</div>
	<button
		type="button"
		onclick={onToggleAssistant}
		aria-label={assistantOpen ? 'Close Zajel' : 'Open Zajel'}
		aria-pressed={assistantOpen}
		title="Zajel"
		class="agent h-12 w-12 grid place-items-center rounded-full text-white shadow-[0_8px_24px_rgba(0,0,0,0.35)] cursor-pointer transition-[filter] hover:brightness-110"
	>
		<Icon name="assistant" size={20} />
	</button>
</div>

<style>
	/* The agent's own colour: teal into a light navy, the same in both themes. */
	.agent {
		background: linear-gradient(135deg, #14b8a6 0%, #1f8ea3 45%, #2d4f9e 100%);
	}
	/* A click is shown by what it opens, not a ring round the button; the
	   keyboard focus ring stays. */
	button:focus:not(:focus-visible) {
		outline: none;
	}
	.new-menu {
		animation: new-menu-in 0.16s cubic-bezier(0.16, 1, 0.3, 1);
	}
	@keyframes new-menu-in {
		from {
			opacity: 0;
			transform: scale(0.95);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.new-menu {
			animation: none;
		}
	}
</style>
