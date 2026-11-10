<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';

	/**
	 * The bottom bar of every app's left column: collapse it to a strip, or
	 * open it again. Same height and bottom gap as the mail list's pager bar
	 * beside it, so their top borders run as one line (md:mb-2 is the content
	 * tray's). Not below `lg`, where the column is a drawer.
	 */
	let { collapsed, onToggle }: { collapsed: boolean; onToggle: () => void } = $props();
</script>

<div class="max-lg:hidden h-10 md:mb-2 flex items-center {collapsed ? 'px-1.5' : 'px-2'} border-t border-border shrink-0">
	<button
		type="button"
		onclick={onToggle}
		class="{collapsed ? 'w-full' : 'w-8 ml-1'} flex items-center justify-center h-8 rounded-lg text-text-tertiary hover:bg-surface-hover hover:text-text transition-colors cursor-pointer"
		title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
		aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
	>
		<!-- Icon only: the tooltip and the label name it. In line with the
		     folder icons above it. -->
		<Icon name={collapsed ? 'expand-sidebar' : 'collapse-sidebar'} />
	</button>
</div>
