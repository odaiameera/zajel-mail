<script lang="ts">
	import type { SaveHost } from '$lib/settings/draft.svelte';

	/**
	 * The Save bar at the foot of a settings page. Nothing on the page is
	 * stored until Save is pressed here (or Cmd/Ctrl+S); Discard puts the
	 * page back to what was last saved.
	 *
	 * It is always in the layout, as an empty strip at the foot of the pane,
	 * and only fades in while something is unsaved (and for a moment after a
	 * save, to say "Saved"). So showing it moves nothing on the page: the
	 * room it takes is there all along, and the last row always ends above
	 * it.
	 */
	let { host }: { host: SaveHost } = $props();

	const message = $derived(
		host.problem
			? { text: host.problem, tone: 'text-danger' }
			: host.error
				? { text: host.error, tone: 'text-danger' }
				: host.dirty
					? { text: 'Unsaved changes', tone: 'text-text-secondary' }
					: host.justSaved
						? { text: 'Saved', tone: 'text-text-secondary' }
						: null
	);

	function onKeydown(e: KeyboardEvent) {
		if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 's') return;
		// With the bar showing, Cmd/Ctrl+S is ours: the browser's "save this
		// page" dialog is never what someone pressing it here wants.
		if (!host.visible) return;
		e.preventDefault();
		void host.saveAll();
	}
</script>

<svelte:window onkeydown={onKeydown} />

<!-- Sticks to the foot of the scrolling pane, so the rows scroll under it.
     It is in the page's flow after the content, and keeps its height while
     hidden, so the last row ends above it rather than behind it. -->
<div
	class="save-bar sticky bottom-0 z-10 h-14 max-md:h-11 transition-[opacity,visibility] duration-150 ease-out motion-reduce:transition-none
		{host.visible ? 'opacity-100 visible' : 'opacity-0 invisible'}"
	aria-hidden={!host.visible}
	data-testid="save-bar"
>
	<div class="h-full bg-bg">
		<div class="save-bar-inner h-full max-w-3xl px-8 max-md:px-4">
			<div class="h-full flex items-center gap-2 border-t border-border">
				<p class="flex-1 min-w-0 text-xs line-clamp-2 {message?.tone ?? ''}" role="status" title={message?.text}>
					{message?.text ?? ''}
				</p>
				{#if host.dirty || host.saving}
					<button type="button" class="btn btn-ghost" disabled={host.saving} onclick={() => host.discardAll()}>
						Discard
					</button>
					<button
						type="button"
						class="btn btn-primary"
						disabled={host.saving || !!host.problem}
						onclick={() => host.saveAll()}
					>
						{host.saving ? 'Saving…' : 'Save'}
					</button>
				{/if}
			</div>
		</div>
	</div>
</div>

<style>
	/*
	 * The two round buttons in the window's corner (CornerActions) float over
	 * the bottom-right of the pane. From `md` up they are level with this bar,
	 * and on a window too narrow for the content column to end before them
	 * they would sit on top of Save. So the bar keeps its buttons clear:
	 * its right padding grows by however far the column reaches under them.
	 *
	 * 100cqw is the pane's width (the outer box is the container and spans
	 * it); 48rem is the column's (max-w-3xl). On a wide window the column ends
	 * well before the corner and the padding is the page's own 2rem.
	 *
	 * On a phone the corner buttons sit above the tab bar, 3rem clear of the
	 * pane's foot, and the bar (h-11) is shorter than that, so it stays under
	 * them.
	 */
	.save-bar {
		container-type: inline-size;
	}
	@media (min-width: 48rem) {
		.save-bar-inner {
			--corner-reach: calc(var(--corner-gap) + 2 * var(--corner-button) + 0.625rem + 1rem);
			padding-right: max(2rem, calc(var(--corner-reach) - max(0px, 100cqw - 48rem)));
		}
	}
</style>
