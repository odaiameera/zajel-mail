<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import { SAVED_FLASH_MS, type SaveHost } from '$lib/settings/draft.svelte';

	/**
	 * The Save pill at the foot of a settings page. Nothing on the page is
	 * stored until Save is pressed here (or Cmd/Ctrl+S); Discard puts the
	 * page back to what was last saved.
	 *
	 * It floats over the foot of the pane and only fades in while something
	 * is unsaved (and for a moment after a save, to say "Saved"). The room
	 * it takes is in the layout all along, so showing it moves nothing on
	 * the page and the last row always ends above it.
	 *
	 * "Saved" is a pill of its own shape: a green tick and the word, the
	 * same space on both sides, which settles in and fades out by itself
	 * over the time the host keeps it. The bar goes at once when it goes:
	 * its words and buttons leave with it, and fading it out left an empty
	 * dark blob on the page for the length of the fade.
	 */
	let { host }: { host: SaveHost } = $props();

	// Nothing to do and nothing wrong: the save went through.
	const saved = $derived(host.justSaved && !host.dirty && !host.saving && !host.problem && !host.error);

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
	class="save-bar sticky bottom-0 z-10 pointer-events-none
		{host.visible ? 'opacity-100 transition-opacity duration-150 ease-out motion-reduce:transition-none' : 'opacity-0'}"
	data-shown={host.visible}
	data-testid="save-bar"
>
	<div class="save-bar-inner max-w-3xl px-8 max-md:px-4 pt-2 pb-4 max-md:pb-1 flex justify-center">
		<div
			class="pill max-w-full min-h-12 max-md:min-h-10 py-1.5 flex items-center rounded-3xl bg-text text-bg
				shadow-[0_8px_24px_rgba(0,0,0,0.35)] {saved ? 'saved pl-3.5 pr-5 gap-2.5' : 'pl-5 pr-2 gap-3'}
				{host.visible ? 'pointer-events-auto' : ''}"
			style:--saved-ms="{SAVED_FLASH_MS}ms"
		>
			{#if message?.wrong}
				<Icon name="error" size={16} />
			{:else if saved}
				<!-- White on green in either theme: the pill under it is dark on a
				     light page and light on a dark one. -->
				<span class="tick grid place-items-center size-5 rounded-full bg-success text-white">
					<Icon name="check" size={12} class="stroke-[3px]" />
				</span>
			{/if}
			<p class="flex-1 min-w-0 py-1 text-[0.8125rem] break-words {saved ? 'font-medium' : ''}" role="status">
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
	 * "Saved" settles in (it takes the place of the wider pill with the
	 * buttons), stays, and is gone by the time the host lets the bar go.
	 */
	.pill.saved {
		animation: saved var(--saved-ms) ease-out both;
	}
	.pill.saved .tick {
		animation: tick 260ms cubic-bezier(0.2, 0.9, 0.3, 1.4) both;
	}
	@keyframes saved {
		0% {
			transform: scale(0.94);
		}
		8% {
			transform: scale(1);
		}
		85% {
			opacity: 1;
			transform: translateY(0);
		}
		100% {
			opacity: 0;
			transform: translateY(0.375rem);
		}
	}
	@keyframes tick {
		from {
			transform: scale(0.4);
		}
		to {
			transform: scale(1);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.pill.saved,
		.pill.saved .tick {
			animation: none;
		}
	}

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
