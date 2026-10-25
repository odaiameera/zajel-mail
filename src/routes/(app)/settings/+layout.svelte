<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import { page } from '$app/state';
	import { pageTitle } from '$lib/utils/title';
	import { groupedSettingsNav } from '$lib/config/settings-nav';
	import { hostAppPanel } from '$lib/app-panel';
	import type { Snippet } from 'svelte';

	let { children }: { children: Snippet } = $props();

	const grouped = groupedSettingsNav();
	// /settings itself is the section list phones open on (see its page).
	const onIndex = $derived(page.url.pathname === '/settings');

	function isActive(slug: string): boolean {
		return page.url.pathname === `/settings/${slug}`;
	}

	// The section list lives in the shell's left column — in place of the
	// mail folders, not beside them — and in the drawer below `lg`. Phones
	// get it as a page of its own instead (/settings).
	const hosted = hostAppPanel(settingsNav);
</script>

<svelte:head><title>{pageTitle({ page: 'Settings' })}</title></svelte:head>

{#snippet settingsNav()}
	<nav class="flex-1 min-h-0 overflow-y-auto px-2 pt-1.5 pb-3" aria-label="Settings">
		<!-- Same height and offset as Compose in the mail sidebar, so the first
		     row lines up with the top bars of the panes beside it. -->
		<a
			href="/inbox"
			class="flex items-center gap-2 h-9 px-3 rounded-lg text-sm text-text-secondary hover:bg-surface-hover hover:text-text transition-colors"
		>
			<Icon name="back" size={14} />
			<span>Back to Inbox</span>
		</a>
		{#each grouped as [group, list] (group)}
			<p class="text-3xs font-semibold uppercase tracking-wider text-text-tertiary px-3 pt-4 pb-1">{group}</p>
			{#each list as item (item.slug)}
				<a
					href="/settings/{item.slug}"
					aria-current={isActive(item.slug) ? 'page' : undefined}
					class="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm transition-colors
						{isActive(item.slug)
							? 'bg-accent/10 text-accent-fg'
							: 'text-text-secondary hover:bg-surface-hover hover:text-text'}"
				>
					<span class="flex-1 truncate">{item.label}</span>
				</a>
			{/each}
		{/each}
	</nav>
{/snippet}

<div class="h-full flex min-h-0 overflow-hidden">
	{#if !hosted}
		<aside class="w-[224px] shrink-0 border-r border-border flex flex-col">{@render settingsNav()}</aside>
	{/if}
	<section class="flex-1 min-h-0 overflow-y-auto">
		<div class="px-8 py-6 max-md:px-4 max-md:py-4 max-md:pb-28 max-w-3xl">
			{#if !onIndex}
				<a
					href="/settings"
					class="md:hidden -ml-1.5 mb-2 inline-flex items-center gap-0.5 h-9 pr-2 text-sm text-accent-fg"
				>
					<Icon name="previous" size={20} />
					<span>Settings</span>
				</a>
			{/if}
			{@render children()}
		</div>
	</section>
</div>
