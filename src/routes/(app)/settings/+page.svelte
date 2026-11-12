<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { clusteredSettingsNav, searchSettings } from '$lib/config/settings-nav';
	import { PHONE_QUERY } from '$lib/stores/viewport';
	import { profilePhoto } from '$lib/stores/profilePhoto';
	import type { LayoutData } from './$types';

	let { data }: { data: LayoutData } = $props();

	// Accounts is the row with your face on it; the rest are the clusters.
	const clusters = clusteredSettingsNav()
		.map((cluster) => cluster.filter((item) => item.slug !== 'accounts'))
		.filter((cluster) => cluster.length > 0);

	const accountCount = $derived((data.accounts ?? []).length);
	const name = $derived(data.displayName || 'Accounts');

	let query = $state('');
	const results = $derived(searchSettings(query));

	onMount(() => {
		if (!window.matchMedia(PHONE_QUERY).matches) goto('/settings/accounts', { replaceState: true });
	});
</script>

{#snippet row(href: string, label: string, detail?: string)}
	<a {href} class="flex items-center gap-3 min-h-[50px] px-4 py-1.5 text-base text-text active:bg-surface-hover">
		<span class="flex-1 min-w-0 flex flex-col">
			<span class="truncate">{label}</span>
			{#if detail}
				<span class="text-xs text-text-tertiary truncate">{detail}</span>
			{/if}
		</span>
		<Icon name="next" size={16} class="text-text-tertiary" />
	</a>
{/snippet}

<div class="md:hidden flex flex-col gap-4">
	<h1 class="text-[1.875rem] leading-9 font-bold tracking-tight text-text">Settings</h1>

	<div class="relative">
		<Icon name="search" size={16} class="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary pointer-events-none" />
		<input
			type="search"
			bind:value={query}
			placeholder="Search"
			aria-label="Search settings"
			class="w-full h-11 pl-9 pr-3 rounded-[10px] bg-surface-hover text-base text-text placeholder-text-tertiary outline-none"
		/>
	</div>

	<nav aria-label="Settings" class="flex flex-col gap-4">
		{#if query.trim()}
			<div class="rounded-xl border border-border bg-bg divide-y divide-border overflow-hidden">
				{#each results as result (result.href + result.label)}
					{@render row(result.href, result.label, result.page)}
				{:else}
					<p class="px-4 py-3.5 text-base text-text-tertiary">No settings found</p>
				{/each}
			</div>
		{:else}
			<div class="rounded-xl border border-border bg-bg overflow-hidden">
				<a href="/settings/accounts" class="flex items-center gap-3 h-[76px] px-4 text-text active:bg-surface-hover">
					<span class="w-12 h-12 shrink-0 rounded-full overflow-hidden bg-accent flex items-center justify-center text-white text-lg font-semibold">
						{#if $profilePhoto.url}
							<img
								src={$profilePhoto.url}
								alt=""
								class="w-full h-full object-cover origin-center"
								style="transform: translate({$profilePhoto.offsetX * (48 / 80)}px, {$profilePhoto.offsetY * (48 / 80)}px) scale({$profilePhoto.zoom});"
							/>
						{:else}
							{name[0]?.toUpperCase()}
						{/if}
					</span>
					<span class="flex-1 min-w-0 flex flex-col">
						<span class="text-base font-semibold truncate">{name}</span>
						<span class="text-sm text-text-tertiary">
							{accountCount === 1 ? '1 account' : `${accountCount} accounts`}
						</span>
					</span>
					<Icon name="next" size={16} class="text-text-tertiary" />
				</a>
			</div>

			{#each clusters as cluster, i (i)}
				<div class="rounded-xl border border-border bg-bg divide-y divide-border overflow-hidden">
					{#each cluster as item (item.slug)}
						{@render row(`/settings/${item.slug}`, item.label)}
					{/each}
				</div>
			{/each}
		{/if}
	</nav>
</div>
