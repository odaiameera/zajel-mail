<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import EmailList from '$lib/components/EmailList.svelte';
	import { pageTitle } from '$lib/utils/title';
	import { goto } from '$app/navigation';
	import type { Token } from '$lib/search/parse';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	function pillClass(kind: string): string {
		if (kind === 'field') return 'bg-accent/15 text-accent-fg ring-1 ring-accent/30';
		if (kind === 'flag') return 'bg-success/15 text-success ring-1 ring-success/30';
		if (kind === 'error') return 'bg-danger/15 text-danger ring-1 ring-danger/30';
		return 'bg-surface-hover text-text-secondary ring-1 ring-border';
	}

	/** Remove one token's span from the raw query and re-run the search. */
	function removeToken(t: Token) {
		const next = (data.raw.slice(0, t.start) + data.raw.slice(t.end))
			.replace(/\s{2,}/g, ' ')
			.trim();
		if (!next) goto('/inbox');
		else goto(`/search?q=${encodeURIComponent(next)}`, { keepFocus: true });
	}

	const title = $derived(data.raw ? `Search: "${data.raw}"` : 'Search');
</script>

<svelte:head>
	<title>{pageTitle({ page: title })}</title>
</svelte:head>

<!--
	Full-height flex column so EmailList gets a bounded height the way it does on
	the inbox (rendered straight into the grid <main>). Without this column the
	list can't scroll and its pagination footer is clipped by main's overflow.
-->
<div class="h-full flex flex-col overflow-hidden">
	{#if data.raw && data.tokens.length > 0}
		<div class="px-4 py-2 border-b border-border flex items-center gap-2 flex-wrap shrink-0">
			<span class="text-xs text-text-tertiary">Filters</span>
			{#each data.tokens as t (t.start)}
				{@const label =
					t.kind === 'field'
						? `${t.field}: ${t.value}`
						: t.kind === 'flag'
							? `${t.op}: ${t.value}`
							: t.kind === 'error'
								? `${t.raw} · ${t.reason}`
								: t.value}
				<button
					type="button"
					onclick={() => removeToken(t)}
					class="group inline-flex items-center gap-1 pl-1.5 pr-1 py-0.5 rounded-md text-xs font-medium cursor-pointer transition-colors {pillClass(t.kind)}"
					title={t.kind === 'error' && 'reason' in t ? t.reason : `Remove "${label}"`}
				>
					<span>{label}</span>
					<span class="opacity-50 group-hover:opacity-100 transition-opacity">
						<Icon name="close" size={12} />
					</span>
				</button>
			{/each}
			<button
				type="button"
				onclick={() => goto('/inbox')}
				class="text-xs text-text-tertiary hover:text-text px-1.5 py-0.5 rounded-md hover:bg-surface-hover cursor-pointer"
			>
				Clear all
			</button>
		</div>
	{/if}

	{#if !data.raw}
		<!-- No query yet -->
		<div class="flex-1 flex flex-col items-center justify-center gap-3 text-center px-6">
			<div class="w-12 h-12 rounded-2xl bg-surface flex items-center justify-center text-text-tertiary">
				<Icon name="search" size={20} />
			</div>
			<p class="text-text font-medium">Search your mail</p>
			<p class="text-sm text-text-tertiary max-w-md leading-relaxed">
				Find messages by sender, subject, or any words. Combine filters like
				<code class="text-text-secondary">from:</code>,
				<code class="text-text-secondary">subject:</code>,
				<code class="text-text-secondary">has:attachment</code>, or
				<code class="text-text-secondary">is:unread</code>.
			</p>
		</div>
	{:else if data.total === 0}
		<!-- Query with no matches -->
		<div class="flex-1 flex flex-col items-center justify-center gap-3 text-center px-6">
			<div class="w-12 h-12 rounded-2xl bg-surface flex items-center justify-center text-text-tertiary">
				<Icon name="no-results" size={20} />
			</div>
			<p class="text-text font-medium">No results</p>
			<p class="text-sm text-text-tertiary max-w-md leading-relaxed">
				Nothing matched <span class="text-text-secondary font-medium">"{data.raw}"</span>. Try
				removing a filter or using fewer words.
			</p>
		</div>
	{:else}
		<div class="flex-1 min-h-0">
			<EmailList
				emails={data.emails}
				total={data.total}
				title="Search results"
				page={data.page}
				pageSize={data.pageSize}
				totalPages={data.totalPages}
				byDate={!data.ranked}
			/>
		</div>
	{/if}
</div>
