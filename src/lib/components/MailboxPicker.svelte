<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import { mailboxIconName } from '$lib/icons';
	import { onMount, tick } from 'svelte';
	import type { Mailbox } from '$lib/jmap/types';
	import type { Label } from '$lib/types/labels';
	import type { IconNode } from '$lib/types/icon-node';
	import { page } from '$app/state';
	import type { MailboxMetaMap } from '$lib/types/mailbox-meta';
	import MailboxIcon from '$lib/components/MailboxIcon.svelte';
	import { canMoveInto, folderOptions, labelsInOrder, movableSystemFolders } from '$lib/mailboxes';

	/**
	 * "Move to…": the one picker for filing mail by hand. Two sections:
	 * Move to (Inbox, Archive, Junk, Trash, then the folder tree, indented)
	 * and Label. Picking a folder moves the message there; picking a label
	 * adds the label and leaves the message where it is. Remind Me Later,
	 * Scheduled, Drafts, Sent and the Labels container are never offered.
	 */
	let {
		mailboxes,
		labels = [],
		excludeIds = [],
		appliedLabelIds = [],
		anchor = null,
		align = 'left',
		onMove,
		onAddLabel,
		onClose
	}: {
		mailboxes: Mailbox[];
		/** The labels with their colours and icons, as the layout has them. */
		labels?: Label[];
		/** Folders not to offer (the one the message is in). */
		excludeIds?: string[];
		/** Labels the message already has, shown ticked. */
		appliedLabelIds?: string[];
		/** Trigger element, used to place the popover. */
		anchor?: HTMLElement | null;
		/** Which edge of the anchor the popover aligns with. */
		align?: 'left' | 'right';
		onMove: (id: string) => void;
		onAddLabel: (id: string) => void;
		onClose: () => void;
	} = $props();

	interface PickerItem {
		id: string;
		name: string;
		section: 'move' | 'label';
		depth: number;
		role?: string | null;
		color?: string;
		iconNode?: IconNode | null;
	}

	const meta = $derived((page.data.mailboxMeta ?? {}) as MailboxMetaMap);
	const labelById = $derived(new Map(labels.map((l) => [l.id, l])));
	const excludeSet = $derived(new Set(excludeIds));
	const appliedSet = $derived(new Set(appliedLabelIds));

	const items = $derived.by<PickerItem[]>(() => {
		const list: PickerItem[] = [];
		for (const m of movableSystemFolders(mailboxes)) {
			if (!excludeSet.has(m.id)) list.push({ id: m.id, name: m.name, section: 'move', depth: 0, role: m.role });
		}
		const byId = new Map(mailboxes.map((m) => [m.id, m]));
		for (const opt of folderOptions(mailboxes)) {
			if (excludeSet.has(opt.id)) continue;
			// The same test the server makes (a folder named "Sent Messages" is not offered).
			const box = byId.get(opt.id);
			if (box && !canMoveInto(box, mailboxes)) continue;
			list.push({ id: opt.id, name: opt.name, section: 'move', depth: opt.depth, iconNode: meta[opt.id]?.iconNode ?? null });
		}
		for (const m of labelsInOrder(mailboxes)) {
			const label = labelById.get(m.id);
			list.push({
				id: m.id,
				name: label?.name ?? m.name,
				section: 'label',
				depth: 0,
				color: label?.color,
				iconNode: label?.iconNode ?? null
			});
		}
		return list;
	});

	let query = $state('');
	let highlight = $state(0);
	let listEl = $state<HTMLDivElement | undefined>(undefined);
	let inputEl = $state<HTMLInputElement | undefined>(undefined);
	let rootEl = $state<HTMLDivElement | undefined>(undefined);

	let top = $state(0);
	let left = $state(0);
	let positioned = $state(false);

	const PICKER_WIDTH = 280;
	const PICKER_MAX_HEIGHT = 360;
	const GAP = 4;

	function computePosition() {
		if (!anchor || typeof window === 'undefined') {
			positioned = true;
			return;
		}
		const rect = anchor.getBoundingClientRect();
		let nextLeft = align === 'right' ? rect.right - PICKER_WIDTH : rect.left;
		nextLeft = Math.max(8, Math.min(nextLeft, window.innerWidth - PICKER_WIDTH - 8));
		const spaceBelow = window.innerHeight - rect.bottom;
		const needed = PICKER_MAX_HEIGHT + GAP + 8;
		const nextTop =
			spaceBelow >= needed || rect.top < needed ? rect.bottom + GAP : Math.max(8, rect.top - PICKER_MAX_HEIGHT - GAP);
		left = nextLeft;
		top = nextTop;
		positioned = true;
	}

	// While searching, the tree's indentation means nothing: matches are flat.
	const filtered = $derived.by(() => {
		const q = query.trim().toLowerCase();
		if (!q) return items;
		return items.filter((i) => i.name.toLowerCase().includes(q)).map((i) => ({ ...i, depth: 0 }));
	});

	$effect(() => {
		if (highlight >= filtered.length) highlight = Math.max(0, filtered.length - 1);
	});

	onMount(() => {
		computePosition();
		inputEl?.focus();
		const onMoveOrResize = () => computePosition();
		window.addEventListener('scroll', onMoveOrResize, true);
		window.addEventListener('resize', onMoveOrResize);
		return () => {
			window.removeEventListener('scroll', onMoveOrResize, true);
			window.removeEventListener('resize', onMoveOrResize);
		};
	});

	function pick(item: PickerItem) {
		if (item.section === 'label') onAddLabel(item.id);
		else onMove(item.id);
	}

	async function scrollHighlightIntoView() {
		await tick();
		listEl?.querySelector<HTMLElement>(`[data-idx="${highlight}"]`)?.scrollIntoView?.({ block: 'nearest' });
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault();
			e.stopPropagation();
			onClose();
		} else if (e.key === 'ArrowDown') {
			e.preventDefault();
			highlight = Math.min(filtered.length - 1, highlight + 1);
			scrollHighlightIntoView();
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			highlight = Math.max(0, highlight - 1);
			scrollHighlightIntoView();
		} else if (e.key === 'Enter') {
			e.preventDefault();
			const item = filtered[highlight];
			if (item) pick(item);
		}
	}

	function handleWindowClick(e: MouseEvent) {
		if (!rootEl || rootEl.contains(e.target as Node)) return;
		if (anchor && anchor.contains(e.target as Node)) return;
		onClose();
	}

	/** Out of the parent (overflow: hidden) onto the body, so it is never clipped. */
	function portal(node: HTMLElement) {
		document.body.appendChild(node);
		return { destroy: () => node.remove() };
	}
</script>

<svelte:window onkeydown={handleKeydown} onclick={handleWindowClick} />

<div
	use:portal
	bind:this={rootEl}
	class="fixed z-[60] w-[280px] bg-surface border border-border rounded-xl shadow-[0_8px_32px_rgba(0,0,0,0.4)] overflow-hidden animate-compose-modal-in"
	style="top: {top}px; left: {left}px; visibility: {positioned ? 'visible' : 'hidden'};"
	role="dialog"
	aria-label="Move to a folder or add a label"
>
	<div class="px-2 py-2 border-b border-border">
		<div class="relative">
			<Icon name="search" size={14} class="absolute left-2 top-1/2 -translate-y-1/2 text-text-tertiary pointer-events-none" />
			<input
				bind:this={inputEl}
				bind:value={query}
				placeholder="Find a folder or label"
				aria-label="Find a folder or label"
				class="w-full bg-surface-hover border border-border rounded-lg pl-7 pr-2 py-1.5 text-sm text-text placeholder-text-tertiary outline-none focus:border-accent transition-colors"
			/>
		</div>
	</div>

	<div bind:this={listEl} class="max-h-[320px] overflow-y-auto py-1">
		{#if filtered.length === 0}
			<p class="px-3 py-6 text-xs text-text-tertiary text-center">No matches</p>
		{:else}
			{#each filtered as item, i (item.id)}
				{#if i === 0 || filtered[i - 1].section !== item.section}
					<p class="px-3 pt-2 pb-1 text-3xs font-semibold uppercase tracking-wide text-text-tertiary" role="presentation">
						{item.section === 'move' ? 'Move to' : 'Label'}
					</p>
				{/if}
				<button
					type="button"
					data-idx={i}
					data-section={item.section}
					onclick={() => pick(item)}
					onmouseenter={() => { highlight = i; }}
					style="padding-left: {12 + item.depth * 14}px"
					class="w-full flex items-center gap-2 pr-3 py-1.5 text-sm text-left transition-colors cursor-pointer
						{highlight === i ? 'bg-accent/10 text-accent-fg' : 'text-text-secondary hover:bg-surface-hover hover:text-text'}"
				>
					{#if item.section === 'label'}
						<span class="w-3.5 h-3.5 shrink-0 flex items-center justify-center"><MailboxIcon node={item.iconNode} fallback="dot" color={item.color ?? '#0969da'} size={14} /></span>
					{:else if item.role}
						<span class="w-3.5 h-3.5 shrink-0 flex items-center justify-center text-current"><Icon name={mailboxIconName(item.role)} size={14} /></span>
					{:else}
						<span class="w-3.5 h-3.5 shrink-0 flex items-center justify-center text-current"><MailboxIcon node={item.iconNode} fallback="folder" size={14} /></span>
					{/if}
					<span class="flex-1 truncate">{item.name}</span>
					{#if item.section === 'label' && appliedSet.has(item.id)}
						<Icon name="check" size={14} />
					{/if}
				</button>
			{/each}
		{/if}
	</div>
</div>
