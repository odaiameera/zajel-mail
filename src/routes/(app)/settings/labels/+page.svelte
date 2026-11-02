<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import { invalidateAll, goto } from '$app/navigation';
	import { page } from '$app/state';
	import { pageTitle } from '$lib/utils/title';
	import type { LayoutData } from '../$types';
	import type { Label } from '$lib/types/labels';
	import { colorByHex, type LabelColor } from '$lib/constants/colors';
	import CreateMailboxModal from '$lib/components/modals/CreateMailboxModal.svelte';
	import MailboxIcon from '$lib/components/MailboxIcon.svelte';
	import { moveStep } from '$lib/utils/folder-tree';

	type EditingMailbox = {
		id: string;
		name: string;
		color: LabelColor;
		icon?: string | null;
		parentId?: string | null;
	};

	let { data }: { data: LayoutData } = $props();

	const labels = $derived(data.labels);

	let modalOpen = $state(false);
	let modalEditing = $state<EditingMailbox | null>(null);

	function openCreate() {
		modalEditing = null;
		modalOpen = true;
	}

	function openEdit(label: Label) {
		modalEditing = {
			id: label.id,
			name: label.name,
			color: colorByHex(label.color),
			icon: label.icon ?? null,
			parentId: null
		};
		modalOpen = true;
	}

	// One place up or down: what a drag in the sidebar does, for keyboards
	// and touch screens. Labels are mailboxes too, so the folders API orders them.
	async function step(label: Label, direction: 'up' | 'down') {
		const request = moveStep(data.mailboxes, label.id, direction);
		if (!request) return;
		const res = await fetch('/api/folders', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ action: 'reorder', ...request })
		});
		const payload = await res.json().catch(() => ({}));
		if (!res.ok || payload?.success === false) {
			alert(payload?.error ?? 'Failed to move label');
			return;
		}
		await invalidateAll();
	}

	async function deleteLabel(label: Label) {
		const msg = `Delete "${label.name}"? Emails tagged with this label will not be deleted.`;
		if (!confirm(msg)) return;
		const res = await fetch('/api/preferences/labels', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ action: 'delete', id: label.id })
		});
		const payload = await res.json().catch(() => ({}));
		if (!res.ok || payload?.success === false) {
			alert(payload?.error ?? 'Failed to delete label');
			return;
		}
		if (page.url.pathname === `/folder/${label.id}`) {
			goto('/inbox');
		}
		await invalidateAll();
	}
</script>

<svelte:head><title>{pageTitle({ page: 'Labels', subtitle: 'Settings' })}</title></svelte:head>

<header class="mb-6 flex items-start justify-between gap-4">
	<div>
		<h1 class="text-xl font-semibold text-text">Labels</h1>
		<p class="text-sm text-text-tertiary mt-1 max-w-prose">
			Labels sync to Apple Mail and Thunderbird as folders under <code class="text-xs bg-surface-hover rounded-md px-1 py-0.5">Labels/</code>.
			Apply them to emails from anywhere in the app; create, rename, recolor, reorder and delete them here, or
			drag them in the sidebar.
		</p>
	</div>
	<button
		type="button"
		onclick={openCreate}
		class="btn btn-primary shrink-0"
	>
		<Icon name="add" size={14} />
		New label
	</button>
</header>

<section class="flex flex-col gap-3">
	{#if labels.length === 0}
		<p class="text-sm text-text-tertiary">You haven't created any labels yet.</p>
	{:else}
		<div class="flex flex-col gap-1.5">
			{#each labels as label (label.id)}
				<div class="flex items-center gap-3 px-3 py-2 rounded-lg bg-surface-hover/50 border border-border/60">
					<MailboxIcon node={label.iconNode} fallback="dot" color={label.color} />
					<span class="flex-1 truncate text-sm text-text">{label.name}</span>
					<a
						href={`/folder/${label.id}`}
						class="text-xs text-text-tertiary hover:text-text transition-colors"
					>View →</a>
					<button
						type="button"
						onclick={() => step(label, 'up')}
						disabled={!moveStep(data.mailboxes, label.id, 'up')}
						title="Move up"
						aria-label="Move {label.name} up"
						class="p-1 rounded-md text-text-tertiary hover:text-text hover:bg-surface transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-default"
					><Icon name="move-up" size={14} /></button>
					<button
						type="button"
						onclick={() => step(label, 'down')}
						disabled={!moveStep(data.mailboxes, label.id, 'down')}
						title="Move down"
						aria-label="Move {label.name} down"
						class="p-1 rounded-md text-text-tertiary hover:text-text hover:bg-surface transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-default"
					><Icon name="move-down" size={14} /></button>
					<button
						type="button"
						onclick={() => openEdit(label)}
						class="text-xs text-text-tertiary hover:text-text px-2 py-1 rounded-md hover:bg-surface transition-colors cursor-pointer"
					>Edit</button>
					<button
						type="button"
						onclick={() => deleteLabel(label)}
						class="text-xs text-text-tertiary hover:text-danger px-2 py-1 rounded-md hover:bg-surface transition-colors cursor-pointer"
					>Delete</button>
				</div>
			{/each}
		</div>
	{/if}
</section>

<CreateMailboxModal
	kind="label"
	open={modalOpen}
	mailboxes={data.mailboxes}
	editing={modalEditing}
	onClose={() => { modalOpen = false; modalEditing = null; }}
/>
