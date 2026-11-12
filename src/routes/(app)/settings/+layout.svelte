<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import { page } from '$app/state';
	import { pageTitle } from '$lib/utils/title';
	import { clusteredSettingsNav, searchSettings, settingsPageFor } from '$lib/config/settings-nav';
	import { hostAppPanel } from '$lib/app-panel';
	import { beforeNavigate, goto } from '$app/navigation';
	import { provideSaveHost } from '$lib/settings/draft.svelte';
	import { LEAVE_PROMPT } from '$lib/settings/leave';
	import SaveBar from '$lib/components/settings/SaveBar.svelte';
	import type { Snippet } from 'svelte';

	let { children, data }: { children: Snippet; data?: { activeAccountId?: string | null } } = $props();

	const clusters = clusteredSettingsNav();
	// /settings itself is the section list phones open on (see its page).
	const onIndex = $derived(page.url.pathname === '/settings');
	// The page that is open, or the one a page under it hangs off
	// (/settings/messages/signatures belongs to Messages & composer).
	const current = $derived(settingsPageFor(page.url.pathname));
	// Where "back" goes on a phone: up to the page above, else to the list.
	const parent = $derived(
		current && page.url.pathname !== `/settings/${current.slug}`
			? { href: `/settings/${current.slug}`, label: current.label }
			: { href: '/settings', label: 'Settings' }
	);

	// The menu's search: what is typed, and what it finds (pages by name,
	// then settings by the words on their rows).
	let query = $state('');
	const results = $derived(searchSettings(query));

	function onSearchKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape' && query) {
			e.preventDefault();
			query = '';
		} else if (e.key === 'Enter' && results.length > 0) {
			e.preventDefault();
			const first = results[0].href;
			query = '';
			void goto(first);
		}
	}

	// The section list lives in the shell's left column — in place of the
	// mail folders, not beside them — and in the drawer below `lg`. Phones
	// get it as a page of its own instead (/settings).
	const hosted = hostAppPanel(settingsNav);

	// Settings wait for Save: the open page hands its unsaved values to this
	// host, and the one Save bar below stores them (see draft.svelte.ts).
	const saveHost = provideSaveHost();

	// Leaving with changes that were never saved would lose them without a
	// word, so it asks first: a link inside the app, the settings menu or the
	// browser's back button here, and closing or reloading the tab below.
	// (What changes something before it navigates, as switching the account,
	// asks before it does anything: canLeaveSettings in leave.ts.)
	beforeNavigate((navigation) => {
		// The tab is going away: that is the browser's own prompt, below.
		if (navigation.willUnload) return;
		const to = navigation.to?.url;
		// The page already open (its own entry in the menu): nothing is left.
		if (to && to.pathname === page.url.pathname) return;
		if (saveHost.saving) {
			// A save under way is not "unsaved": hold the navigation until it
			// is over. Stored, it goes on; refused, the page stays with its
			// changes and the bar says why.
			navigation.cancel();
			void saveHost.settled().then((stored) => {
				if (!stored || !to) return;
				if (to.origin === page.url.origin) void goto(to.pathname + to.search + to.hash);
				else location.assign(to.href);
			});
			return;
		}
		if (!saveHost.dirty) return;
		if (confirm(LEAVE_PROMPT)) {
			// Discarding also takes back anything previewed live (the theme).
			saveHost.discardAll();
		} else {
			navigation.cancel();
		}
	});

	// Browsers show their own wording for this; the text is for the few that don't.
	function onBeforeUnload(e: BeforeUnloadEvent) {
		if (!saveHost.dirty) return;
		e.preventDefault();
		e.returnValue = LEAVE_PROMPT;
	}
</script>

<svelte:window onbeforeunload={onBeforeUnload} />

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
			<span>Inbox</span>
		</a>

		<!-- The icon lies over the field's own padding, so the field is one
		     box and its focus ring goes round all of it. -->
		<div class="relative mt-2">
			<Icon name="search" size={14} class="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary pointer-events-none" />
			<input
				type="search"
				bind:value={query}
				onkeydown={onSearchKeydown}
				placeholder="Search settings"
				aria-label="Search settings"
				class="w-full h-9 pl-[2.125rem] pr-3 rounded-lg border border-border bg-bg text-sm text-text placeholder-text-tertiary outline-none focus:border-accent transition-colors"
			/>
		</div>

		{#if query.trim()}
			<!-- What the search found, in place of the menu. -->
			<ul class="mt-4 flex flex-col gap-0.5" aria-label="Search results">
				{#each results as result (result.href + result.label)}
					<li>
						<a
							href={result.href}
							onclick={() => (query = '')}
							class="flex flex-col justify-center min-h-[34px] px-3 py-1.5 rounded-lg text-sm text-text-secondary hover:bg-surface-hover hover:text-text transition-colors"
						>
							<span class="truncate">{result.label}</span>
							{#if result.page}
								<span class="text-2xs text-text-tertiary truncate">{result.page}</span>
							{/if}
						</a>
					</li>
				{:else}
					<li class="px-3 py-1.5 text-sm text-text-tertiary">No settings found</li>
				{/each}
			</ul>
		{:else}
			<!-- No headings: pages that belong together sit together, and the
			     space between the clusters does the rest. -->
			{#each clusters as cluster, i (i)}
				<div class="mt-4 flex flex-col gap-0.5">
					{#each cluster as item (item.slug)}
						{@const active = current?.slug === item.slug}
						<a
							href="/settings/{item.slug}"
							aria-current={active ? 'page' : undefined}
							class="flex items-center h-[34px] px-3 rounded-lg text-sm transition-colors
								{active
									? 'bg-accent/10 text-accent-fg font-medium'
									: 'text-text-secondary hover:bg-surface-hover hover:text-text'}"
						>
							<span class="flex-1 truncate">{item.label}</span>
						</a>
					{/each}
				</div>
			{/each}
		{/if}
	</nav>
{/snippet}

<div class="h-full flex min-h-0 overflow-hidden">
	{#if !hosted}
		<aside class="w-[224px] shrink-0 border-r border-border flex flex-col">{@render settingsNav()}</aside>
	{/if}
	<section class="flex-1 min-h-0 overflow-y-auto" data-settings-content>
		<!-- At least as tall as the pane, so the Save bar's strip sits at its
		     foot on a short page and sticks there on a long one. -->
		<div class="min-h-full flex flex-col">
			<!-- The bottom padding plus the bar's strip keep the last row clear
			     of the round corner buttons on a phone, as pb-28 did alone. -->
			<div class="flex-1 w-full max-w-3xl px-8 pt-10 pb-6 max-md:px-4 max-md:pt-4 max-md:pb-16">
				{#if !onIndex}
					<!-- On a phone: up to the list. A page under another (Signatures)
					     shows the way up on a wide window too, where the menu marks
					     only the page it hangs off. -->
					<a
						href={parent.href}
						class="{parent.href === '/settings' ? 'md:hidden' : ''} -ml-1.5 mb-2 inline-flex items-center gap-0.5 h-9 pr-2 text-sm text-accent-fg"
					>
						<Icon name="previous" size={20} />
						<span>{parent.label}</span>
					</a>
				{/if}
				<!-- A page's saved values belong to the account in use: when that
				     changes, the page starts again from the new one's. -->
				{#key data?.activeAccountId}
					{@render children()}
				{/key}
			</div>
			<SaveBar host={saveHost} />
		</div>
	</section>
</div>
