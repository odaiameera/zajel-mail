<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import type { SaveHost } from '$lib/settings/draft.svelte';

	/**
	 * The Save pill at the foot of a settings page. Nothing on the page is
	 * stored until Save is pressed here (or Cmd/Ctrl+S); Discard puts the
	 * page back to what was last saved.
	 *
	 * It floats over the foot of the pane and only fades in while something
	 * is unsaved (and for a moment after a save, to say "Saved"). The room
	 * it takes is in the layout all along, so showing it moves nothing on
	 * the page and the last row always ends above it.
	 */
	let { host }: { host: SaveHost } = $props();

	const message = $derived(
		host.problem
			? { text: host.problem, wrong: true }
			: host.error
				? { text: host.error, wrong: true }
				: host.dirty
					? { text: 'Unsaved changes', wrong: false }
					: host.justSaved
						? { text: 'Saved', wrong: false }
						: null
	);

	/**
	 * Whether a key pressed with focus here is the settings page's: on the
	 * page itself, or nowhere in particular. Not in a dialog, nor in
	 * something with a Save of its own (the signature editor), nor outside
	 * the settings content (a message being written, the assistant).
	 */
	function onThePage(target: EventTarget | null): boolean {
		if (!(target instanceof Element) || target === document.body || target === document.documentElement) return true;
		if (target.closest('[role="dialog"], [role="alertdialog"], dialog, [data-own-save]')) return false;
		return target.closest('[data-settings-content]') !== null;
	}

	function onKeydown(e: KeyboardEvent) {
		if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 's') return;
		// With the bar showing, Cmd/Ctrl+S is ours: the browser's "save this
		// page" dialog is never what someone pressing it here wants.
		if (!host.visible || !onThePage(e.target)) return;
		e.preventDefault();
		void host.saveAll();
	}
</script>

<svelte:window onkeydown={onKeydown} />

<!-- Sticks to the foot of the scrolling pane, so the rows scroll under it.
     It is in the page's flow after the content, and keeps its height while
     hidden, so the last row ends above it rather than behind it. A long
     message wraps and the pill grows upward to show all of it.
     Hidden, it is only see-through and lets clicks pass: its status line
     stays a live region all along, so a screen reader hears "Unsaved
     changes" or the reason a save failed as the text changes, and with
     nothing changed it holds no text and no buttons.
     The pill is the page's colours turned round (dark on a light page), so
     it reads as lying on top of the page; a message about something wrong
     is marked by an icon, which stays legible on either. -->
<div
	class="save-bar sticky bottom-0 z-10 pointer-events-none transition-opacity duration-150 ease-out motion-reduce:transition-none
		{host.visible ? 'opacity-100' : 'opacity-0'}"
	data-shown={host.visible}
	data-testid="save-bar"
>
	<div class="save-bar-inner max-w-3xl px-8 max-md:px-4 pt-2 pb-4 max-md:pb-1 flex justify-center">
		<div
			class="max-w-full min-h-12 max-md:min-h-10 pl-5 pr-2 py-1.5 flex items-center gap-3 rounded-3xl bg-text text-bg
				shadow-[0_8px_24px_rgba(0,0,0,0.35)] {host.visible ? 'pointer-events-auto' : ''}"
		>
			{#if message?.wrong}
				<Icon name="error" size={16} />
			{/if}
			<p class="flex-1 min-w-0 py-1 text-[0.8125rem] break-words" role="status">
				{message?.text ?? ''}
			</p>
			{#if host.dirty || host.saving}
				<!-- Under a message of several lines they keep to the foot. -->
				<div class="flex items-center gap-1 shrink-0 self-end">
					<button
						type="button"
						class="h-8 px-3 rounded-full text-[0.8125rem] font-medium cursor-pointer opacity-80 hover:opacity-100 transition-opacity disabled:opacity-40 disabled:cursor-default"
						disabled={host.saving}
						onclick={() => host.discardAll()}
					>
						Discard
					</button>
					<button
						type="button"
						class="h-8 px-4 rounded-full bg-accent text-white text-[0.8125rem] font-semibold cursor-pointer hover:bg-accent-hover transition-colors disabled:opacity-50 disabled:cursor-default"
						disabled={host.saving || !!host.problem}
						onclick={() => host.saveAll()}
					>
						{host.saving ? 'Saving…' : 'Save'}
					</button>
				</div>
			{/if}
		</div>
	</div>
</div>

<style>
	/*
	 * The two round buttons in the window's corner (CornerActions) float over
	 * the bottom-right of the pane. From `md` up they are level with this bar,
	 * and on a window too narrow for the content column to end before them
	 * they would sit on top of the pill. So the bar keeps it clear:
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
