<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { groupedSettingsNav } from '$lib/config/settings-nav';
	import { PHONE_QUERY } from '$lib/stores/viewport';

	const grouped = groupedSettingsNav();

	onMount(() => {
		if (!window.matchMedia(PHONE_QUERY).matches) goto('/settings/account', { replaceState: true });
	});
</script>

<div class="md:hidden">
	<h1 class="text-xl font-semibold text-text mb-2">Settings</h1>
	<nav aria-label="Settings">
		{#each grouped as [group, list] (group)}
			<p class="text-3xs font-semibold uppercase tracking-wider text-text-tertiary px-1 pt-5 pb-1.5">{group}</p>
			<div class="rounded-xl border border-border bg-surface divide-y divide-border overflow-hidden">
				{#each list as item (item.slug)}
					<a
						href="/settings/{item.slug}"
						class="flex items-center gap-3 h-12 px-4 text-sm text-text active:bg-surface-hover"
					>
						<span class="flex-1 truncate">{item.label}</span>
						<Icon name="next" size={16} class="text-text-tertiary" />
					</a>
				{/each}
			</div>
		{/each}
	</nav>
</div>
