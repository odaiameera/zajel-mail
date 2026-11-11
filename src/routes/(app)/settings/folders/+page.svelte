<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import { onMount } from 'svelte';
	import { pageTitle } from '$lib/utils/title';
	import { filesInto, type Rule } from '$lib/types/rules';
	import MailboxRow from '$lib/components/settings/MailboxRow.svelte';
	import type { LayoutData } from '../$types';
	import type { Mailbox } from '$lib/jmap/types';
	import { findLabelsParentId, isLabelMailbox, isLabelsParent } from '$lib/types/labels';
	import { colorByHex, type LabelColor } from '$lib/constants/colors';
	import { buildFolderTree, flattenFolderTree } from '$lib/utils/folder-tree';
	import CreateMailboxModal from '$lib/components/modals/CreateMailboxModal.svelte';

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

	// The rules that file into each folder, for the delete confirmation.
	let rules = $state<Rule[]>([]);
	async function loadRules() {
		const res = await fetch('/api/rules').catch(() => null);
		const body = res?.ok ? ((await res.json().catch(() => null)) as { rules?: Rule[] } | null) : null;
		rules = body?.rules ?? [];
	}
	onMount(loadRules);

	let error = $state('');
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
	{#if error}
		<p class="px-3 py-2 rounded-lg bg-danger/10 border border-danger/20 text-danger text-xs" role="alert">{error}</p>
	{/if}
	<div>
		<h2 class="text-xs font-semibold uppercase tracking-wider text-text-tertiary mb-2">Your folders</h2>
		{#if flatFolders.length === 0}
			<p class="text-sm text-text-tertiary">No user folders yet.</p>
		{:else}
			<div class="flex flex-col">
				{#each flatFolders as opt (opt.id)}
					{@const folder = folderById.get(opt.id)}
					{#if folder}
						{@const meta = data.mailboxMeta[folder.id]}
						<MailboxRow
							mailbox={folder}
							kind="folder"
							mailboxes={data.mailboxes}
							depth={opt.depth}
							color={meta?.color ?? null}
							iconNode={meta?.iconNode ?? null}
							rules={rules.filter((r) => filesInto(r, folder.id))}
							target={null}
							onEdit={() => openEdit(folder)}
							onOpenRule={() => {}}
							onAddRule={() => {}}
							onToggleRule={() => {}}
							onError={(message) => (error = message)}
							onChanged={loadRules}
						/>
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
