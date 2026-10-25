<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import type { IconName } from '$lib/icons';
	import { page } from '$app/state';
	import { isPhone } from '$lib/stores/viewport';

	type RailItem = {
		id: string;
		label: string;
		href?: string;
		icon: IconName;
		/** Routes to the /apps placeholder rather than a built feature. Dims the
		 *  icon and says so in the tooltip, so the rail doesn't promise a screen
		 *  that isn't there yet. */
		comingSoon?: boolean;
	};

	// Phones open Settings on its section list; wider screens have that list
	// in the left column, so they start on the first section.
	const settingsHref = $derived($isPhone ? '/settings' : '/settings/account');

	// The three built surfaces in the order they get used (Zajel, the AI mail
	// agent, lives in the bottom-right corner, beside Compose). Unbuilt apps (Tasks)
	// stay off the rail until they exist — a dimmed icon that leads to a
	// "coming soon" page promises a screen and then doesn't deliver it.
	const items: RailItem[] = [
		{
			id: 'mail',
			label: 'Mail',
			href: '/inbox',
			icon: 'mail'
		},
		{
			id: 'calendar',
			label: 'Calendar',
			href: '/calendar',
			icon: 'calendar'
		},
		{
			id: 'contacts',
			label: 'Contacts',
			href: '/contacts',
			icon: 'contacts'
		}
	];

	function isActive(href?: string): boolean {
		if (!href) return false;
		const path = page.url.pathname;
		if (href === '/inbox') {
			return (
				path.startsWith('/inbox') ||
				path.startsWith('/folder') ||
				path.startsWith('/email') ||
				path.startsWith('/search') ||
				path.startsWith('/flagged')
			);
		}
		return path.startsWith(href);
	}

	const settingsActive = $derived(page.url.pathname.startsWith('/settings'));
</script>

<!-- A vertical rail from `md` up; on phones the same items lay out as a
     bottom tab bar (the layout puts it in the grid's last row), minus what
     isn't built yet. -->
<div class="md:col-start-4 md:row-start-2 max-md:row-start-3 w-[52px] shrink-0 bg-surface flex flex-col items-center py-3 gap-1 overflow-hidden
	max-md:w-full max-md:h-[calc(3.5rem+env(safe-area-inset-bottom))] max-md:flex-row max-md:justify-around max-md:py-0 max-md:pb-[env(safe-area-inset-bottom)] max-md:border-t max-md:border-border">
	{#each items as item (item.id)}
		<a
			href={item.href}
			title={item.comingSoon ? `${item.label} (coming soon)` : item.label}
			aria-label={item.comingSoon ? `${item.label} (coming soon)` : item.label}
			aria-current={isActive(item.href) ? 'page' : undefined}
			class="w-9 h-9 max-md:w-11 max-md:h-11 rounded-lg flex items-center justify-center transition-colors cursor-pointer
				{isActive(item.href)
					? 'text-accent-fg bg-accent/10'
					: 'text-text-tertiary hover:text-text hover:bg-surface-hover'}
				{item.comingSoon && !isActive(item.href) ? 'opacity-50 max-md:hidden' : ''}"
		>
			<Icon name={item.icon} size={20} />
		</a>
	{/each}

	<!-- Spacer pushes Settings to the bottom of the rail -->
	<div class="flex-1 max-md:hidden"></div>

	<!-- Separator -->
	<div class="h-px w-6 bg-border/30 my-1 max-md:hidden"></div>

	<!-- Settings -->
	<a
		href={settingsHref}
		data-sveltekit-preload-data="hover"
		title="Settings"
		aria-label="Settings"
		aria-current={settingsActive ? 'page' : undefined}
		class="w-9 h-9 max-md:w-11 max-md:h-11 rounded-lg flex items-center justify-center transition-colors cursor-pointer
			{settingsActive
				? 'text-accent-fg bg-accent/10'
				: 'text-text-tertiary hover:text-text hover:bg-surface-hover'}"
	>
		<Icon name="settings" size={20} />
	</a>
</div>
