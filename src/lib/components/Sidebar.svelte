<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import MailboxIcon from '$lib/components/MailboxIcon.svelte';
	import CollapseBar from '$lib/components/CollapseBar.svelte';
	import { mailboxIconName } from '$lib/icons';
	import { slide } from 'svelte/transition';
	import { page } from '$app/state';
	import { invalidateAll } from '$app/navigation';
	import {
		createFolderExpandedStore,
		isExpandedDefault,
		SECTION_FOLDERS,
		SECTION_LABELS
	} from '$lib/stores/folderExpanded';
	import type { Mailbox } from '$lib/jmap/types';
	import type { Label } from '$lib/types/labels';
	import { findLabelsParentId } from '$lib/types/labels';
	import type { MailboxMetaMap } from '$lib/types/mailbox-meta';
	import { showToast } from '$lib/stores/toast';
	import { isScheduledMailbox } from '$lib/jmap/mailbox';
	import { canMoveInto, mailboxKind } from '$lib/mailboxes';
	import {
		buildFolderTree,
		descendantIds,
		filterUserFolders,
		orderedSiblings,
		type FolderTreeNode,
		type ReorderRequest
	} from '$lib/utils/folder-tree';

	let {
		mailboxes,
		labels = [],
		folderExpanded = {},
		hideHeader = false,
		collapsed = false,
		onToggleCollapse
	}: {
		mailboxes: Mailbox[];
		labels?: Label[];
		folderExpanded?: Record<string, boolean>;
		hideHeader?: boolean;
		collapsed?: boolean;
		onToggleCollapse?: () => void;
	} = $props();

	const expanded = createFolderExpandedStore(folderExpanded);

	// Colour and icon of each folder, from the page (mailbox_meta). Labels
	// carry theirs in `labels`, built from the same table.
	const meta = $derived((page.data.mailboxMeta ?? {}) as MailboxMetaMap);

	// --- Mailbox classification ---

	const systemOrder: Record<string, number> = {
		inbox: 0,
		'remind-me-later': 1,
		drafts: 2,
		scheduled: 2.5,
		sent: 3,
		archive: 4,
		junk: 5,
		trash: 6
	};

	/**
	 * "Remind Me Later" and "Scheduled" are the app's own mailboxes, usually
	 * without a role in JMAP, so they are tagged here as pseudo-system folders
	 * that sort next to the Inbox and get their own icons.
	 */
	function pseudoRole(m: Mailbox): string | null {
		const kind = mailboxKind(m, mailboxes);
		if (kind === 'special') return isScheduledMailbox(m) ? 'scheduled' : 'remind-me-later';
		if (kind === 'system') return m.role;
		return null;
	}

	const systemFolders = $derived(
		mailboxes
			.filter((m) => pseudoRole(m) !== null && m.name !== 'Sent Messages')
			.sort((a, b) => {
				const ao = systemOrder[pseudoRole(a) ?? ''] ?? 10;
				const bo = systemOrder[pseudoRole(b) ?? ''] ?? 10;
				if (ao !== bo) return ao - bo;
				return a.sortOrder - b.sortOrder;
			})
	);

	const labelsParentId = $derived(findLabelsParentId(mailboxes));

	// The same tree Settings and the folder pickers show, in the order the
	// user gave it (sortOrder, then name).
	const userFolders = $derived(filterUserFolders(mailboxes));
	const userFolderTree = $derived(buildFolderTree(mailboxes));

	function isExpanded(id: string): boolean {
		return isExpandedDefault(id, $expanded);
	}

	// --- Routing helpers ---

	function getMailboxHref(m: { id: string; role?: string | null }): string {
		if (m.role === 'inbox') return '/inbox';
		return `/folder/${m.id}`;
	}

	function isMailboxActive(m: { id: string; role?: string | null }): boolean {
		// A message open full-page keeps its folder highlighted, so you can
		// still see where you are and where Back goes.
		if (page.url.pathname.startsWith('/email/') && page.data.email?.mailboxIds?.[m.id]) return true;
		if (m.role === 'inbox') return page.url.pathname.startsWith('/inbox');
		return page.url.pathname === `/folder/${m.id}`;
	}

	// Flagged is a virtual view (a keyword query, not a mailbox), so it gets
	// its own entry instead of riding the mailbox list.
	const flaggedActive = $derived(page.url.pathname.startsWith('/flagged'));

	function isLabelActive(label: Label): boolean {
		return page.url.pathname === `/folder/${label.id}`;
	}

	// Active-label lookup so we can show unread badges on labels. Each label
	// id *is* a mailbox id, so we join to the mailbox list.
	function getLabelUnread(id: string): number {
		const m = mailboxes.find((mb) => mb.id === id);
		return m?.unreadEmails ?? 0;
	}

	// --- Drag-to-move drop targets ---

	const EMAIL_DRAG_TYPE = 'application/x-email-ids';
	let dragOverId = $state<string | null>(null);

	/**
	 * Mail can be dropped on a folder it may be moved into, or on a label,
	 * which adds the label. Not on Drafts, Sent, Scheduled (only Send later
	 * puts mail there) or Remind Me Later (a drop there set no reminder).
	 */
	function canDropOn(m: Mailbox): boolean {
		if (m.name === 'Sent Messages') return false;
		return canMoveInto(m, mailboxes) || mailboxKind(m, mailboxes) === 'label';
	}

	function hasEmailPayload(e: DragEvent): boolean {
		return !!e.dataTransfer?.types?.includes(EMAIL_DRAG_TYPE);
	}

	function onRowDragOver(e: DragEvent) {
		if (!hasEmailPayload(e)) return;
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
	}

	function onRowDragEnter(e: DragEvent, id: string) {
		if (!hasEmailPayload(e)) return;
		dragOverId = id;
	}

	function onRowDragLeave(e: DragEvent, id: string) {
		// Only clear if we're actually leaving this row — ignore transitions
		// between children of the row.
		const related = e.relatedTarget as Node | null;
		const current = e.currentTarget as Node;
		if (related && current.contains(related)) return;
		if (dragOverId === id) dragOverId = null;
	}

	async function onRowDrop(e: DragEvent, targetMailboxId: string) {
		if (!hasEmailPayload(e)) return;
		e.preventDefault();
		dragOverId = null;

		const raw = e.dataTransfer?.getData(EMAIL_DRAG_TYPE);
		if (!raw) return;
		let ids: unknown;
		try { ids = JSON.parse(raw); } catch { return; }
		if (!Array.isArray(ids) || ids.length === 0) return;

		// The server decides what a drop does: on a folder the messages move
		// there (out of every other folder, keeping their labels); on a label
		// they gain the label and stay where they are.
		const body = { ids, action: 'moveTo', targetMailboxId };

		await fetch('/api/email/bulk', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body)
		});
		await invalidateAll();
	}

	// --- Rearranging folders and labels by dragging their rows ---
	//
	// A row dragged onto another row lands before it (top quarter), after it
	// (bottom quarter) or inside it (the middle; folders only). Labels move
	// among labels and folders among folders; the server renumbers the level
	// and keeps the order in every client that honours JMAP sortOrder. The
	// Move up / Move down buttons in Settings do the same without a pointer.

	const MAILBOX_DRAG_TYPE = 'application/x-mailbox-id';
	type DropWhere = 'before' | 'after' | 'into';
	/** The row being dragged; dataTransfer can't be read during dragover. */
	let mailboxDrag = $state<{ id: string; label: boolean } | null>(null);
	/** The row under the pointer and where relative to it the drop would land. */
	let mailboxDrop = $state<{ id: string; where: DropWhere } | null>(null);

	function hasMailboxPayload(e: DragEvent): boolean {
		return !!e.dataTransfer?.types?.includes(MAILBOX_DRAG_TYPE);
	}

	function onMailboxDragStart(e: DragEvent, id: string, label: boolean) {
		if (!e.dataTransfer) return;
		e.dataTransfer.setData(MAILBOX_DRAG_TYPE, JSON.stringify({ id, label }));
		e.dataTransfer.effectAllowed = 'move';
		mailboxDrag = { id, label };
	}

	function onMailboxDragEnd() {
		mailboxDrag = null;
		mailboxDrop = null;
	}

	/** Can what is being dragged land on this row at all? */
	function canPlace(targetId: string, targetIsLabel: boolean): boolean {
		if (!mailboxDrag) return false;
		if (mailboxDrag.label !== targetIsLabel) return false;
		if (mailboxDrag.id === targetId) return false;
		// A folder can't go inside itself or one of its own children.
		if (!targetIsLabel && descendantIds(mailboxes, mailboxDrag.id).has(targetId)) return false;
		return true;
	}

	function dropZone(e: DragEvent, allowInto: boolean): DropWhere {
		const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
		const y = (e.clientY - rect.top) / Math.max(rect.height, 1);
		if (!allowInto) return y < 0.5 ? 'before' : 'after';
		if (y < 0.25) return 'before';
		if (y > 0.75) return 'after';
		return 'into';
	}

	function rowDragOver(e: DragEvent, target: { id: string }, isLabel: boolean) {
		if (hasEmailPayload(e)) return onRowDragOver(e);
		if (!hasMailboxPayload(e) || !canPlace(target.id, isLabel)) return;
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
		mailboxDrop = { id: target.id, where: dropZone(e, !isLabel) };
	}

	function rowDragLeave(e: DragEvent, id: string) {
		onRowDragLeave(e, id);
		const related = e.relatedTarget as Node | null;
		if (related && (e.currentTarget as Node).contains(related)) return;
		if (mailboxDrop?.id === id) mailboxDrop = null;
	}

	async function rowDrop(e: DragEvent, target: { id: string; parentId: string | null }, isLabel: boolean) {
		if (hasEmailPayload(e)) return onRowDrop(e, target.id);
		if (!hasMailboxPayload(e)) return;
		e.preventDefault();
		const drag = mailboxDrag;
		const drop = mailboxDrop;
		const allowed = canPlace(target.id, isLabel);
		onMailboxDragEnd();
		if (!drag || !drop || drop.id !== target.id || !allowed) return;

		let request: ReorderRequest;
		if (drop.where === 'into') {
			request = { id: drag.id, parentId: target.id, beforeId: null };
		} else {
			const parentId = isLabel ? labelsParentId : target.parentId;
			const siblings = orderedSiblings(mailboxes, parentId, isLabel)
				.map((m) => m.id)
				.filter((id) => id !== drag.id);
			const at = siblings.indexOf(target.id);
			const beforeId = drop.where === 'before' ? target.id : (siblings[at + 1] ?? null);
			request = { id: drag.id, parentId, beforeId };
		}
		await reorder(request);
	}

	// The "Folders" heading takes a folder too: to the top level, last.
	function headerDragOver(e: DragEvent) {
		if (!hasMailboxPayload(e) || !mailboxDrag || mailboxDrag.label) return;
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
		mailboxDrop = { id: SECTION_FOLDERS, where: 'into' };
	}

	async function headerDrop(e: DragEvent) {
		if (!hasMailboxPayload(e)) return;
		e.preventDefault();
		const drag = mailboxDrag;
		onMailboxDragEnd();
		if (!drag || drag.label) return;
		await reorder({ id: drag.id, parentId: null, beforeId: null });
	}

	async function reorder(request: ReorderRequest) {
		const res = await fetch('/api/folders', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ action: 'reorder', ...request })
		});
		const data = await res.json().catch(() => ({}));
		if (!res.ok || data?.success === false) {
			showToast({ message: data?.error ?? 'Could not move it' });
			return;
		}
		await invalidateAll();
	}

	/** The row's state classes: a drop about to land, or the usual active/hover look. */
	function rowLook(id: string, active: boolean): string {
		if (dragOverId === id || (mailboxDrop?.id === id && mailboxDrop.where === 'into')) {
			return 'bg-accent/20 text-accent-fg ring-1 ring-accent/40';
		}
		const base = active ? 'bg-accent/10 text-accent-fg' : 'text-text/85 hover:bg-surface-hover hover:text-text';
		if (mailboxDrop?.id === id) return `${base} ${mailboxDrop.where === 'before' ? 'drop-before' : 'drop-after'}`;
		return base;
	}
</script>

<aside class="w-full h-full bg-surface flex flex-col overflow-hidden">
	{#if !hideHeader && !collapsed}
		<div class="px-4 py-3">
			<h1 class="text-lg font-bold text-text tracking-tight leading-none">zajel.</h1>
		</div>
	{/if}

	<!-- Compose lives in the bottom-right corner, beside Zajel. -->
	<div class="h-1.5 shrink-0" aria-hidden="true"></div>

	{#if collapsed}
		<!-- Collapsed: flat icon list, tooltips only -->
		<nav class="flex-1 overflow-y-auto py-1 px-1.5 flex flex-col gap-0.5">
			{#each systemFolders as mailbox (mailbox.id)}
				<a
					href={getMailboxHref(mailbox)}
					title={mailbox.name}
					class="flex items-center justify-center py-2 rounded-lg transition-colors
						{isMailboxActive(mailbox)
							? 'bg-accent/10 text-accent-fg'
							: 'text-text/85 hover:bg-surface-hover hover:text-text'}"
				>
					<span class="w-4 h-4 shrink-0 flex items-center justify-center text-current"><Icon name={mailboxIconName(pseudoRole(mailbox))} /></span>
				</a>
				{#if pseudoRole(mailbox) === 'inbox'}
					<a
						href="/flagged"
						title="Starred"
						class="flex items-center justify-center py-2 rounded-lg transition-colors
							{flaggedActive
								? 'bg-accent/10 text-accent-fg'
								: 'text-text/85 hover:bg-surface-hover hover:text-text'}"
					>
						<span class="w-4 h-4 shrink-0 flex items-center justify-center text-current"><Icon name="star" /></span>
					</a>
				{/if}
			{/each}

			{#if userFolders.length > 0}
				<div class="h-px w-6 bg-border/30 mx-auto my-1"></div>
			{/if}
			{#each userFolders as mailbox (mailbox.id)}
				<a
					href={getMailboxHref(mailbox)}
					title={mailbox.name}
					class="flex items-center justify-center py-2 rounded-lg transition-colors
						{isMailboxActive(mailbox)
							? 'bg-accent/10 text-accent-fg'
							: 'text-text/85 hover:bg-surface-hover hover:text-text'}"
				>
					<span class="w-4 h-4 shrink-0 flex items-center justify-center text-current"><MailboxIcon node={meta[mailbox.id]?.iconNode} fallback="folder" color={meta[mailbox.id]?.color ?? null} /></span>
				</a>
			{/each}

			{#if labels.length > 0}
				<div class="h-px w-6 bg-border/30 mx-auto my-1"></div>
			{/if}
			{#each labels as label (label.id)}
				<a
					href={`/folder/${label.id}`}
					title={label.name}
					class="flex items-center justify-center py-2 rounded-lg transition-colors
						{isLabelActive(label) ? 'bg-accent/10' : 'hover:bg-surface-hover'}"
				>
					<MailboxIcon node={label.iconNode} fallback="dot" color={label.color} />
				</a>
			{/each}
		</nav>
	{:else}
		<!-- Expanded: grouped, nested tree -->
		<nav class="flex-1 overflow-y-auto py-1 px-2">
			<!-- System folders -->
			{#each systemFolders as mailbox (mailbox.id)}
				{@const droppable = canDropOn(mailbox)}
				<a
					href={getMailboxHref(mailbox)}
					ondragover={droppable ? onRowDragOver : undefined}
					ondragenter={droppable ? (e) => onRowDragEnter(e, mailbox.id) : undefined}
					ondragleave={droppable ? (e) => onRowDragLeave(e, mailbox.id) : undefined}
					ondrop={droppable ? (e) => onRowDrop(e, mailbox.id) : undefined}
					class="flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors
						{dragOverId === mailbox.id
							? 'bg-accent/20 text-accent-fg ring-1 ring-accent/40'
							: isMailboxActive(mailbox)
								? 'bg-accent/10 text-accent-fg'
								: 'text-text/85 hover:bg-surface-hover hover:text-text'}"
				>
					<span class="w-4 h-4 shrink-0 flex items-center justify-center text-current"><Icon name={mailboxIconName(pseudoRole(mailbox))} /></span>
					<span class="flex-1 truncate">{mailbox.name}</span>
					{#if mailbox.unreadEmails > 0}
						<span class="text-xs font-medium bg-accent/15 text-accent-fg px-1.5 py-0.5 rounded-full">{mailbox.unreadEmails}</span>
					{/if}
				</a>
				{#if pseudoRole(mailbox) === 'inbox'}
					<a
						href="/flagged"
						class="flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors
							{flaggedActive
								? 'bg-accent/10 text-accent-fg'
								: 'text-text/85 hover:bg-surface-hover hover:text-text'}"
					>
						<span class="w-4 h-4 shrink-0 flex items-center justify-center text-current"><Icon name="star" /></span>
						<span class="flex-1 truncate">Starred</span>
					</a>
				{/if}
			{/each}

			<!-- FOLDERS section -->
			<div class="mt-4 mb-1 pl-3 pr-1">
				<button
					onclick={() => expanded.toggle(SECTION_FOLDERS)}
					ondragover={headerDragOver}
					ondragleave={(e) => rowDragLeave(e, SECTION_FOLDERS)}
					ondrop={headerDrop}
					class="w-full flex items-center gap-1.5 py-1 rounded-md text-3xs font-semibold uppercase tracking-wider text-text-tertiary hover:text-text-secondary cursor-pointer
						{mailboxDrop?.id === SECTION_FOLDERS ? 'bg-accent/20 text-accent-fg ring-1 ring-accent/40' : ''}"
				>
					<span class="chevron {isExpanded(SECTION_FOLDERS) ? 'expanded' : ''}">
						<Icon name="expand" size={12} />
					</span>
					Folders
				</button>
			</div>

			{#if isExpanded(SECTION_FOLDERS)}
				<div transition:slide={{ duration: 150 }}>
					{#if userFolderTree.length === 0}
						<p class="text-2xs text-text-tertiary/70 px-3 py-2 italic">No folders yet</p>
					{:else}
						{@render folderTree(userFolderTree, 0)}
					{/if}
				</div>
			{/if}

			<!-- LABELS section -->
			<div class="mt-4 mb-1 pl-3 pr-1">
				<button
					onclick={() => expanded.toggle(SECTION_LABELS)}
					class="w-full flex items-center gap-1.5 py-1 text-3xs font-semibold uppercase tracking-wider text-text-tertiary hover:text-text-secondary cursor-pointer"
				>
					<span class="chevron {isExpanded(SECTION_LABELS) ? 'expanded' : ''}">
						<Icon name="expand" size={12} />
					</span>
					Labels
				</button>
			</div>

			{#if isExpanded(SECTION_LABELS)}
				<div transition:slide={{ duration: 150 }}>
					{#if labels.length === 0}
						<p class="text-2xs text-text-tertiary/70 px-3 py-2 italic">No labels yet</p>
					{:else}
						{#each labels as label (label.id)}
							<a
								href={`/folder/${label.id}`}
								draggable="true"
								ondragstart={(e) => onMailboxDragStart(e, label.id, true)}
								ondragend={onMailboxDragEnd}
								ondragover={(e) => rowDragOver(e, label, true)}
								ondragenter={(e) => onRowDragEnter(e, label.id)}
								ondragleave={(e) => rowDragLeave(e, label.id)}
								ondrop={(e) => rowDrop(e, { id: label.id, parentId: labelsParentId }, true)}
								class="flex items-center gap-2.5 px-3 py-1.5 rounded-lg text-sm transition-colors {rowLook(label.id, isLabelActive(label))}"
							>
								<MailboxIcon node={label.iconNode} fallback="dot" color={label.color} />
								<span class="flex-1 truncate">{label.name}</span>
								{#if getLabelUnread(label.id) > 0}
									<span class="text-xs font-medium bg-accent/15 text-accent-fg px-1.5 py-0.5 rounded-full shrink-0">{getLabelUnread(label.id)}</span>
								{/if}
							</a>
						{/each}
					{/if}
				</div>
			{/if}
		</nav>
	{/if}

	<CollapseBar {collapsed} onToggle={() => onToggleCollapse?.()} />
</aside>

{#snippet folderTree(nodes: FolderTreeNode[], depth: number)}
	{#each nodes as node (node.id)}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			draggable="true"
			ondragstart={(e) => onMailboxDragStart(e, node.id, false)}
			ondragend={onMailboxDragEnd}
			ondragover={(e) => rowDragOver(e, node, false)}
			ondragenter={(e) => onRowDragEnter(e, node.id)}
			ondragleave={(e) => rowDragLeave(e, node.id)}
			ondrop={(e) => rowDrop(e, node, false)}
			class="relative flex items-center gap-2.5 pr-1 py-1.5 rounded-lg text-sm transition-colors {rowLook(node.id, isMailboxActive(node))}"
			style="padding-left: {0.75 * (depth + 1)}rem"
		>
			<!--
				The expander sits in the row's own left padding rather than in the
				flow, which is what puts a top-level folder's icon at the same 12px
				as Inbox and Sent above it. Previously every folder reserved a 20px
				chevron slot in-flow — even leaves, which have no chevron — so the
				whole section sat indented from the system list for no reason a
				reader could see. Nested levels still step in one unit each, and the
				chevron follows them.

				The unit is 0.75rem rather than 12px because the system rows use
				Tailwind's px-3 and layout.css scales every rem by a 107.5% root
				font-size; a hardcoded 12px drifts out of alignment as soon as
				that knob moves.
			-->
			{#if node.children.length > 0}
				<button
					onclick={() => expanded.toggle(node.id)}
					title={isExpanded(node.id) ? 'Collapse' : 'Expand'}
					class="absolute top-1/2 -translate-y-1/2 w-3 h-5 flex items-center justify-center text-current opacity-70 hover:opacity-100 cursor-pointer"
					style="left: {depth * 0.75}rem"
				>
					<span class="chevron {isExpanded(node.id) ? 'expanded' : ''}">
						<Icon name="expand" size={12} />
					</span>
				</button>
			{/if}

			<a
				href={getMailboxHref(node)}
				class="flex-1 min-w-0 flex items-center gap-2 text-inherit no-underline"
			>
				<span
					class="w-4 h-4 shrink-0 flex items-center justify-center"
					style={meta[node.id]?.color ? `color: ${meta[node.id]?.color}` : ''}
				><MailboxIcon node={meta[node.id]?.iconNode} fallback="folder" /></span>
				<span class="flex-1 truncate">{node.name}</span>
				{#if node.unreadEmails > 0}
					<span class="text-xs font-medium bg-accent/15 text-accent-fg px-1.5 py-0.5 rounded-full shrink-0">{node.unreadEmails}</span>
				{/if}
			</a>
		</div>
		{#if node.children.length > 0 && isExpanded(node.id)}
			<div transition:slide={{ duration: 150 }}>
				{@render folderTree(node.children, depth + 1)}
			</div>
		{/if}
	{/each}
{/snippet}

<style>
	.chevron {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		transition: transform 150ms ease;
	}
	.chevron.expanded {
		transform: rotate(90deg);
	}
	/* Where a dragged folder or label is about to land: a line along the
	   edge it goes next to. Landing inside uses the same ring as a mail drop. */
	.drop-before {
		box-shadow: inset 0 2px 0 0 var(--color-accent);
	}
	.drop-after {
		box-shadow: inset 0 -2px 0 0 var(--color-accent);
	}
</style>
