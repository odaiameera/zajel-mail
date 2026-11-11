<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import { onMount } from 'svelte';
	import { pageTitle } from '$lib/utils/title';
	import { filesInto, type Rule } from '$lib/types/rules';
	import MailboxRow from '$lib/components/settings/MailboxRow.svelte';
	import type { LayoutData } from '../$types';
	import type { Label } from '$lib/types/labels';
	import { colorByHex, type LabelColor } from '$lib/constants/colors';
	import CreateMailboxModal from '$lib/components/modals/CreateMailboxModal.svelte';

	type EditingMailbox = {
		id: string;
		name: string;
		color: LabelColor | null;
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

	// The rules that file into each label, for the delete confirmation.
	let rules = $state<Rule[]>([]);
	async function loadRules() {
		const res = await fetch('/api/rules').catch(() => null);
		const body = res?.ok ? ((await res.json().catch(() => null)) as { rules?: Rule[] } | null) : null;
		rules = body?.rules ?? [];
	}
	onMount(loadRules);

	let error = $state('');
	const mailboxById = $derived(new Map(data.mailboxes.map((m) => [m.id, m])));
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
	{#if error}
		<p class="px-3 py-2 rounded-lg bg-danger/10 border border-danger/20 text-danger text-xs" role="alert">{error}</p>
	{/if}
	{#if labels.length === 0}
		<p class="text-sm text-text-tertiary">You haven't created any labels yet.</p>
	{:else}
		<div class="flex flex-col">
			{#each labels as label (label.id)}
				{@const mailbox = mailboxById.get(label.id)}
				{#if mailbox}
					<MailboxRow
						{mailbox}
						kind="label"
						mailboxes={data.mailboxes}
						color={label.color}
						iconNode={label.iconNode ?? null}
						rules={rules.filter((r) => filesInto(r, label.id))}
						target={null}
						onEdit={() => openEdit(label)}
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
</section>

<CreateMailboxModal
	kind="label"
	open={modalOpen}
	mailboxes={data.mailboxes}
	editing={modalEditing}
	onClose={() => { modalOpen = false; modalEditing = null; }}
/>
