<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import { untrack } from 'svelte';
	import { navigating, page } from '$app/state';
	import { moveToCategory } from '$lib/categories/api';
	import { glideFrom, prefersReducedMotion } from '$lib/transitions';
	import {
		INBOX_CATEGORIES,
		inboxTabHref,
		parseInboxCategory,
		type InboxCategory,
		type InboxTabsState
	} from '$lib/types/categories';
	import { CATEGORY_ICON } from './category-icons';

	let { tabs }: { tabs: InboxTabsState } = $props();

	// The tab drawn as current. It follows a click at once, while the new
	// tab's mail is still loading, so the underline answers the click and the
	// list follows when the mail lands; `tabs.active` is the tab the list
	// holds, and catches up a moment later. A navigation that leaves this
	// page doesn't count, and one that fails falls back to `tabs.active`.
	const shown = $derived.by<InboxCategory>(() => {
		const to = navigating.to;
		if (to?.route.id && to.route.id === page.route.id) {
			return parseInboxCategory(to.url.searchParams.get('category'));
		}
		return tabs.active;
	});

	// The underline glides from the old tab to the new one. Each tab draws
	// its own with CSS, so at rest it is always exactly under its tab — on
	// first paint, after a resize, when the labels fold away in a narrow
	// column — and only the move between two tabs is animated: where the
	// underline was is read before the DOM moves it, and the new one is slid
	// over from there.
	let strip = $state<HTMLElement>();
	let underlineWas: DOMRect | null = null;

	function underline(): HTMLElement | null {
		return strip?.querySelector<HTMLElement>('[data-tab-underline]') ?? null;
	}

	$effect.pre(() => {
		void shown;
		untrack(() => {
			underlineWas = underline()?.getBoundingClientRect() ?? null;
		});
	});

	$effect(() => {
		void shown;
		untrack(() => {
			const from = underlineWas;
			underlineWas = null;
			const el = underline();
			if (from && el && !prefersReducedMotion()) glideFrom(el, from);
		});
	});

	// Rows are dragged with the same payload the sidebar folders accept, so a
	// tab is just one more drop target: dropping sets the category.
	const EMAIL_DRAG_TYPE = 'application/x-email-ids';
	let dragOver = $state<InboxCategory | null>(null);

	function hasEmailPayload(e: DragEvent): boolean {
		return !!e.dataTransfer?.types?.includes(EMAIL_DRAG_TYPE);
	}

	function onDragOver(e: DragEvent, key: InboxCategory) {
		if (!hasEmailPayload(e) || key === tabs.active) return;
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
		dragOver = key;
	}

	function onDragLeave(e: DragEvent, key: InboxCategory) {
		const related = e.relatedTarget as Node | null;
		if (related && (e.currentTarget as Node).contains(related)) return;
		if (dragOver === key) dragOver = null;
	}

	async function onDrop(e: DragEvent, key: InboxCategory) {
		if (!hasEmailPayload(e)) return;
		e.preventDefault();
		dragOver = null;
		let ids: unknown;
		try {
			ids = JSON.parse(e.dataTransfer?.getData(EMAIL_DRAG_TYPE) ?? '');
		} catch {
			return;
		}
		if (!Array.isArray(ids) || ids.length === 0) return;
		// The list only ever shows the active tab's mail, so that is where
		// every dragged row came from — which is what Undo needs.
		await moveToCategory(ids as string[], key, tabs.active);
	}

	function formatCount(n: number): string {
		return n > 999 ? '999+' : String(n);
	}
</script>

<!--
	The list column is often narrower than four labelled tabs (420px by
	default beside the reading pane), so below ~36rem the inactive tabs
	collapse to icon + count and only the active tab keeps its label. The
	label stays in the accessibility tree either way, and in the tooltip.
-->
<nav
	aria-label="Inbox tabs"
	class="@container border-b border-border shrink-0"
>
	<div bind:this={strip} class="flex items-stretch gap-0.5 px-2 overflow-x-auto [scrollbar-width:none]">
		{#each INBOX_CATEGORIES as c (c.key)}
			{@const active = shown === c.key}
			{@const unread = tabs.unread[c.key]}
			<a
				href={inboxTabHref(page.url, c.key)}
				title={c.description}
				aria-current={tabs.active === c.key ? 'page' : undefined}
				ondragover={(e) => onDragOver(e, c.key)}
				ondragleave={(e) => onDragLeave(e, c.key)}
				ondrop={(e) => onDrop(e, c.key)}
				class="relative flex items-center gap-1.5 px-2.5 py-2 my-1 rounded-md text-sm whitespace-nowrap no-underline transition-colors
					{dragOver === c.key
						? 'bg-accent/10 text-accent-fg ring-1 ring-accent'
						: active
							? 'text-text font-semibold'
							: 'text-text-secondary hover:text-text hover:bg-surface-hover'}"
			>
				<span class="shrink-0 transition-colors {active ? 'text-text' : 'text-text-tertiary'}"><Icon name={CATEGORY_ICON[c.key]} size={16} /></span>
				<span class={active ? '' : 'sr-only @xl:not-sr-only'}>{c.label}</span>
				{#if unread > 0}
					<span
						class="rounded-full px-1.5 py-px text-2xs font-medium tabular-nums transition-colors
							{active ? 'bg-accent text-white' : 'bg-surface-hover text-text-secondary'}"
						aria-label="{unread} unread"
					>
						{formatCount(unread)}
					</span>
				{/if}
				{#if active}
					<span data-tab-underline class="absolute left-2 right-2 -bottom-1 h-0.5 rounded-full bg-accent" aria-hidden="true"></span>
				{/if}
			</a>
		{/each}
	</div>
</nav>
