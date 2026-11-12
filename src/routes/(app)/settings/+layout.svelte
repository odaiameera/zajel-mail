<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import { page } from '$app/state';
	import { pageTitle } from '$lib/utils/title';
	import { groupedSettingsNav } from '$lib/config/settings-nav';
	import { hostAppPanel } from '$lib/app-panel';
	import { beforeNavigate, goto } from '$app/navigation';
	import { provideSaveHost } from '$lib/settings/draft.svelte';
	import { LEAVE_PROMPT } from '$lib/settings/leave';
	import SaveBar from '$lib/components/settings/SaveBar.svelte';
	import type { Snippet } from 'svelte';

	let { children, data }: { children: Snippet; data?: { activeAccountId?: string | null } } = $props();

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
	<section class="flex-1 min-h-0 overflow-y-auto" data-settings-content>
		<!-- At least as tall as the pane, so the Save bar's strip sits at its
		     foot on a short page and sticks there on a long one. -->
		<div class="min-h-full flex flex-col">
			<!-- The bottom padding plus the bar's strip keep the last row clear
			     of the round corner buttons on a phone, as pb-28 did alone. -->
			<div class="flex-1 w-full max-w-3xl px-8 pt-6 pb-6 max-md:px-4 max-md:pt-4 max-md:pb-16">
				{#if !onIndex}
					<a
						href="/settings"
						class="md:hidden -ml-1.5 mb-2 inline-flex items-center gap-0.5 h-9 pr-2 text-sm text-accent-fg"
					>
						<Icon name="previous" size={20} />
						<span>Settings</span>
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
