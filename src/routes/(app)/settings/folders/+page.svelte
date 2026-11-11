<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import { invalidateAll, goto } from '$app/navigation';
	import { page } from '$app/state';
	import { pageTitle } from '$lib/utils/title';
	import { mailboxDeleteRulesNote, type Rule } from '$lib/types/rules';
	import type { LayoutData } from '../$types';
	import type { Mailbox } from '$lib/jmap/types';
	import { findLabelsParentId, isLabelMailbox, isLabelsParent } from '$lib/types/labels';
	import { colorByHex, type LabelColor } from '$lib/constants/colors';
	import { buildFolderTree, flattenFolderTree, moveStep } from '$lib/utils/folder-tree';
	import CreateMailboxModal from '$lib/components/modals/CreateMailboxModal.svelte';
	import MailboxIcon from '$lib/components/MailboxIcon.svelte';

	type EditingMailbox = {
		id: string;
		name: string;
		color: LabelColor | null;
		icon?: string | null;
		parentId?: string | null;
	};

	let { data }: { data: LayoutData } = $props();

	const labelsParentId = $derived(findLabelsParentId(data.mailboxes));
	const userFolders = $derived(
		data.mailboxes.filter(
			(m) => m.role === null && !isLabelMailbox(m, labelsParentId) && !isLabelsParent(m, labelsParentId)
		)
	);
	const systemFolders = $derived(data.mailboxes.filter((m) => m.role !== null));

	// Flat ordered list honoring the folder tree, with depth for indentation.
	const flatFolders = $derived(flattenFolderTree(buildFolderTree(data.mailboxes)));
	const folderById = $derived(new Map(userFolders.map((m) => [m.id, m])));

	let modalOpen = $state(false);
	let modalEditing = $state<EditingMailbox | null>(null);

	function openCreate() {
		modalEditing = null;
		modalOpen = true;
	}

	function openEdit(folder: Mailbox) {
		const meta = data.mailboxMeta[folder.id];
		modalEditing = {
			id: folder.id,
			name: folder.name,
			color: meta?.color ? colorByHex(meta.color) : null,
			icon: meta?.icon ?? null,
			parentId: folder.parentId
		};
		modalOpen = true;
	}

	// One place up or down among its siblings: what a drag in the sidebar
	// does, for keyboards and touch screens.
	async function step(folder: Mailbox, direction: 'up' | 'down') {
		const request = moveStep(data.mailboxes, folder.id, direction);
		if (!request) return;
		const res = await fetch('/api/folders', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ action: 'reorder', ...request })
		});
		const payload = await res.json().catch(() => ({}));
		if (!res.ok || payload?.success === false) {
			alert(payload?.error ?? 'Failed to move folder');
			return;
		}
		await invalidateAll();
	}

	/** What deleting a folder or label does to the rules that file into it, for the confirmation; '' when there are none. */
	async function rulesNote(id: string): Promise<string> {
		const res = await fetch('/api/rules').catch(() => null);
		const body = res?.ok ? ((await res.json().catch(() => null)) as { rules?: Rule[] } | null) : null;
		const note = mailboxDeleteRulesNote(body?.rules ?? [], id);
		return note ? ` ${note}` : '';
	}

	async function deleteFolder(folder: Mailbox) {
		const msg = `Delete "${folder.name}"? Messages inside will not be deleted — move them first if you want to keep them somewhere else.${await rulesNote(folder.id)}`;
		if (!confirm(msg)) return;
		const res = await fetch('/api/folders', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ action: 'delete', id: folder.id })
		});
		const payload = await res.json().catch(() => ({}));
		if (!res.ok || payload?.success === false) {
			alert(payload?.error ?? 'Failed to delete folder');
			return;
		}
		if (page.url.pathname === `/folder/${folder.id}`) {
			goto('/inbox');
		}
		await invalidateAll();
	}
</script>

<svelte:head><title>{pageTitle({ page: 'Folders', subtitle: 'Settings' })}</title></svelte:head>

<header class="mb-6 flex items-start justify-between gap-4">
	<div>
		<h1 class="text-xl font-semibold text-text">Folders</h1>
		<p class="text-sm text-text-tertiary mt-1 max-w-prose">
			Folders are real JMAP mailboxes — they show up in Apple Mail, Outlook, and any other client
			connected to the same account. Create, rename, recolor, reorder and reparent them here, or
			drag them in the sidebar.
		</p>
	</div>
	<button
		type="button"
		onclick={openCreate}
		class="btn btn-primary shrink-0"
	>
		<Icon name="add" size={14} />
		New folder
	</button>
</header>

<section class="flex flex-col gap-5">
	<div>
		<h2 class="text-xs font-semibold uppercase tracking-wider text-text-tertiary mb-2">Your folders</h2>
		{#if flatFolders.length === 0}
			<p class="text-sm text-text-tertiary">No user folders yet.</p>
		{:else}
			<div class="flex flex-col gap-1.5">
				{#each flatFolders as opt (opt.id)}
					{@const folder = folderById.get(opt.id)}
					{#if folder}
						{@const meta = data.mailboxMeta[folder.id]}
						<div
							class="group flex items-center gap-3 px-3 py-2 rounded-lg bg-surface-hover/50 border border-border/60"
							style="padding-left: {12 + opt.depth * 16}px"
						>
							<MailboxIcon node={meta?.iconNode} fallback="folder" color={meta?.color ?? null} />
							<span class="flex-1 truncate text-sm text-text">{folder.name}</span>
							{#if folder.unreadEmails > 0}
								<span class="text-xs text-text-tertiary shrink-0">{folder.unreadEmails} unread</span>
							{/if}
							<a
								href={`/folder/${folder.id}`}
								class="text-xs text-text-tertiary hover:text-text transition-colors"
							>View →</a>
							<button
								type="button"
								onclick={() => step(folder, 'up')}
								disabled={!moveStep(data.mailboxes, folder.id, 'up')}
								title="Move up"
								aria-label="Move {folder.name} up"
								class="p-1 rounded-md text-text-tertiary hover:text-text hover:bg-surface transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-default"
							><Icon name="move-up" size={14} /></button>
							<button
								type="button"
								onclick={() => step(folder, 'down')}
								disabled={!moveStep(data.mailboxes, folder.id, 'down')}
								title="Move down"
								aria-label="Move {folder.name} down"
								class="p-1 rounded-md text-text-tertiary hover:text-text hover:bg-surface transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-default"
							><Icon name="move-down" size={14} /></button>
							<button
								type="button"
								onclick={() => openEdit(folder)}
								class="text-xs text-text-tertiary hover:text-text px-2 py-1 rounded-md hover:bg-surface transition-colors cursor-pointer"
							>Edit</button>
							<button
								type="button"
								onclick={() => deleteFolder(folder)}
								class="text-xs text-text-tertiary hover:text-danger px-2 py-1 rounded-md hover:bg-surface transition-colors cursor-pointer"
							>Delete</button>
						</div>
					{/if}
				{/each}
			</div>
		{/if}
	</div>

	<div>
		<h2 class="text-xs font-semibold uppercase tracking-wider text-text-tertiary mb-2">System folders</h2>
		<p class="text-xs text-text-tertiary mb-2">These are managed by the server and can't be renamed or deleted.</p>
		<div class="flex flex-col gap-1.5">
			{#each systemFolders as mb (mb.id)}
				<div class="flex items-center gap-3 px-3 py-2 rounded-lg bg-surface-hover/30 border border-border/40">
					<span class="flex-1 truncate text-sm text-text-secondary">{mb.name}</span>
					<span class="text-3xs text-text-tertiary uppercase tracking-wider">{mb.role ?? ''}</span>
				</div>
			{/each}
		</div>
	</div>
</section>

<CreateMailboxModal
	kind="folder"
	open={modalOpen}
	mailboxes={data.mailboxes}
	editing={modalEditing}
	onClose={() => { modalOpen = false; modalEditing = null; }}
/>
