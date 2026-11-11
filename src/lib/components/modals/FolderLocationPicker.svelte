<script lang="ts">
	import type { Mailbox } from '$lib/jmap/types';
	import { folderOptions, type FolderOption } from '$lib/mailboxes';
	import { descendantIds } from '$lib/utils/folder-tree';

	let {
		value,
		mailboxes,
		excludeId = null,
		onChange
	}: {
		value: string | null;
		mailboxes: Mailbox[];
		excludeId?: string | null;
		onChange: (parentId: string | null) => void;
	} = $props();

	const options = $derived.by<FolderOption[]>(() => {
		// The same folders, in the same order, as "Move to…" and the rule editor.
		const flat = folderOptions(mailboxes);
		if (!excludeId) return flat;
		const excluded = descendantIds(mailboxes, excludeId);
		return flat.filter((opt) => !excluded.has(opt.id));
	});
</script>

<select
	class="w-full appearance-none bg-surface-hover border border-border rounded-lg pl-3 pr-8 py-2 text-sm text-text outline-none focus:border-accent transition-colors"
	value={value ?? ''}
	onchange={(e) => onChange(e.currentTarget.value || null)}
	style="background-image: url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2212%22 height=%2212%22 viewBox=%220 0 24 24%22 fill=%22none%22 stroke=%22%23888%22 stroke-width=%221.75%22 stroke-linecap=%22round%22 stroke-linejoin=%22round%22><path d=%22m6 9 6 6 6-6%22/></svg>'); background-repeat: no-repeat; background-position: right 0.65rem center;"
>
	<option value="">No parent folder</option>
	{#each options as opt (opt.id)}
		<option value={opt.id}>
			{'— '.repeat(opt.depth)}{opt.name}
		</option>
	{/each}
</select>
