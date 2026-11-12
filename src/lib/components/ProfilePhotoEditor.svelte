<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import { onMount, type Snippet } from 'svelte';
	import { profilePhoto } from '$lib/stores/profilePhoto';
	import { resizeImage } from '$lib/utils/image';

	/**
	 * Your own photo: pick one, drag it into place, zoom, then Save. Shown on
	 * the profile card in the header and under Settings, Accounts.
	 *
	 * `stacked` is the card's layout (photo, zoom, whatever the card puts
	 * under them, then the buttons); `row` is a settings row, with the photo
	 * first and the buttons at the end.
	 */
	let {
		letter,
		color = null,
		variant = 'stacked',
		editing = $bindable(false),
		children
	}: {
		/** Drawn in the circle while there is no photo. */
		letter: string;
		/** The circle's colour while there is no photo; the accent when left out. */
		color?: string | null;
		variant?: 'stacked' | 'row';
		/** True from the first change until Save or Cancel. */
		editing?: boolean;
		/** Stacked only: what goes between the photo and its buttons. */
		children?: Snippet;
	} = $props();

	// Committed state (mirrors the store)
	let committedUrl = $state<string | null>(null);
	let committedZoom = $state(1);
	let committedOffsetX = $state(0);
	let committedOffsetY = $state(0);

	// Pending edit state (before Save)
	let pendingUrl = $state<string | null>(null);
	let pendingZoom = $state(1);
	let pendingOffsetX = $state(0);
	let pendingOffsetY = $state(0);
	let saving = $state(false);

	let fileInput = $state<HTMLInputElement | undefined>(undefined);
	let avatarEl = $state<HTMLButtonElement | undefined>(undefined);

	// Drag state
	const AVATAR_SIZE = 80; // px — the editor avatar is 80×80
	let dragging = $state(false);
	let justDragged = false; // suppress click-to-open-picker after a drag
	let dragStartX = 0;
	let dragStartY = 0;
	let dragStartOffsetX = 0;
	let dragStartOffsetY = 0;

	const MIN_ZOOM = 1;
	const MAX_ZOOM = 3;

	const unsubscribe = profilePhoto.subscribe((s) => {
		committedUrl = s.url;
		committedZoom = s.zoom;
		committedOffsetX = s.offsetX;
		committedOffsetY = s.offsetY;
		if (!editing) {
			pendingUrl = s.url;
			pendingZoom = s.zoom;
			pendingOffsetX = s.offsetX;
			pendingOffsetY = s.offsetY;
		}
	});

	onMount(() => {
		profilePhoto.hydrate();
		return () => unsubscribe();
	});

	/**
	 * Bound the pan so the image edges can't be dragged inside the crop frame.
	 * The image is sized to cover the 80×80 box, then scaled by `zoom`. Excess
	 * on each side (which can be panned into view) is `(80*zoom - 80) / 2`.
	 */
	function clampOffset(x: number, y: number, zoom: number): { x: number; y: number } {
		const excess = (AVATAR_SIZE * zoom - AVATAR_SIZE) / 2;
		const max = Math.max(0, excess);
		return {
			x: Math.max(-max, Math.min(max, x)),
			y: Math.max(-max, Math.min(max, y))
		};
	}

	// Re-clamp pan whenever zoom changes so shrinking doesn't leave the image
	// outside its valid range.
	$effect(() => {
		const clamped = clampOffset(pendingOffsetX, pendingOffsetY, pendingZoom);
		if (clamped.x !== pendingOffsetX) pendingOffsetX = clamped.x;
		if (clamped.y !== pendingOffsetY) pendingOffsetY = clamped.y;
	});

	function handlePhotoClick() {
		// If the pointerup just ended a drag, swallow the synthetic click
		// rather than opening the file picker.
		if (justDragged) {
			justDragged = false;
			return;
		}
		fileInput?.click();
	}

	function handleFileChange(e: Event) {
		const file = (e.target as HTMLInputElement).files?.[0];
		if (!file) return;
		const reader = new FileReader();
		reader.onload = async () => {
			const raw = reader.result as string;
			try {
				const compressed = await resizeImage(raw);
				pendingUrl = compressed;
			} catch {
				pendingUrl = raw;
			}
			pendingZoom = 1;
			pendingOffsetX = 0;
			pendingOffsetY = 0;
			editing = true;
		};
		reader.readAsDataURL(file);
		// reset input so selecting the same file twice still fires change
		(e.target as HTMLInputElement).value = '';
	}

	function handleSave() {
		if (!pendingUrl) return;
		saving = true;
		profilePhoto.save(pendingUrl, pendingZoom, pendingOffsetX, pendingOffsetY);
		editing = false;
		saving = false;
	}

	function handleCancel() {
		pendingUrl = committedUrl;
		pendingZoom = committedZoom;
		pendingOffsetX = committedOffsetX;
		pendingOffsetY = committedOffsetY;
		editing = false;
	}

	function handleRemove() {
		profilePhoto.clear();
		pendingUrl = null;
		pendingZoom = 1;
		pendingOffsetX = 0;
		pendingOffsetY = 0;
		editing = false;
	}

	// --- Drag handlers (pointer events cover mouse + touch + pen) ---

	function onPointerDown(e: PointerEvent) {
		if (!pendingUrl) return;
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		dragging = true;
		justDragged = false;
		dragStartX = e.clientX;
		dragStartY = e.clientY;
		dragStartOffsetX = pendingOffsetX;
		dragStartOffsetY = pendingOffsetY;
		editing = true;
		e.preventDefault();
	}

	function onPointerMove(e: PointerEvent) {
		if (!dragging) return;
		const dx = e.clientX - dragStartX;
		const dy = e.clientY - dragStartY;
		// Flag as a drag once the pointer has moved past a small threshold,
		// so a tiny jitter on a plain click still opens the file picker.
		if (!justDragged && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) {
			justDragged = true;
		}
		const clamped = clampOffset(
			dragStartOffsetX + dx,
			dragStartOffsetY + dy,
			pendingZoom
		);
		pendingOffsetX = clamped.x;
		pendingOffsetY = clamped.y;
	}

	function onPointerUp(e: PointerEvent) {
		if (!dragging) return;
		dragging = false;
		try {
			(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
		} catch {
			// ignore — pointer may already be released
		}
	}

	const hasPendingChanges = $derived(
		editing && (
			pendingUrl !== committedUrl ||
			pendingZoom !== committedZoom ||
			pendingOffsetX !== committedOffsetX ||
			pendingOffsetY !== committedOffsetY
		)
	);


	/** Back to the photo as saved. For the card's Escape. */
	export function cancel() {
		handleCancel();
	}
</script>

{#snippet photo()}
	<button
		bind:this={avatarEl}
		type="button"
		onclick={handlePhotoClick}
		onpointerdown={onPointerDown}
		onpointermove={onPointerMove}
		onpointerup={onPointerUp}
		onpointercancel={onPointerUp}
		class="relative w-20 h-20 shrink-0 rounded-full overflow-hidden group bg-accent touch-none
			{pendingUrl ? (dragging ? 'cursor-grabbing' : 'cursor-grab') : 'cursor-pointer'}"
		style={color ? `background-color: ${color}` : undefined}
		title={pendingUrl ? 'Drag to reposition, click to change' : 'Click to upload'}
		aria-label={pendingUrl ? 'Change photo' : 'Upload a photo'}
	>
		{#if pendingUrl}
			<img
				src={pendingUrl}
				alt="Profile"
				class="w-full h-full object-cover origin-center pointer-events-none select-none"
				style="transform: translate({pendingOffsetX}px, {pendingOffsetY}px) scale({pendingZoom});"
				draggable="false"
			/>
		{:else}
			<div class="w-full h-full flex items-center justify-center text-white text-2xl font-semibold pointer-events-none">
				{letter}
			</div>
		{/if}
		<div class="absolute inset-0 bg-black/40 text-white opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center pointer-events-none">
			<Icon name="photo" size={20} />
		</div>
	</button>
	<input bind:this={fileInput} type="file" accept="image/*" class="hidden" onchange={handleFileChange} />
{/snippet}

{#snippet zoom()}
	<Icon name="zoom-out" size={14} class="text-text-tertiary" />
	<input
		type="range"
		min={MIN_ZOOM}
		max={MAX_ZOOM}
		step="0.01"
		bind:value={pendingZoom}
		oninput={() => { editing = true; }}
		class="flex-1 min-w-0 accent-accent cursor-pointer"
		title="Zoom"
		aria-label="Zoom"
	/>
	<Icon name="zoom-in" size={16} class="text-text-tertiary" />
{/snippet}

{#if variant === 'row'}
	<div class="flex flex-wrap items-center gap-x-4 gap-y-3 px-5 py-3.5 max-md:px-4">
		{@render photo()}
		<div class="flex-1 min-w-[9rem]">
			<p class="text-sm font-medium text-text">Photo</p>
			<!-- Zoom is there whenever there is a photo to zoom. -->
			{#if pendingUrl}
				<div class="flex items-center gap-2 mt-2 max-w-56">{@render zoom()}</div>
			{/if}
		</div>
		<div class="flex items-center gap-2">
			{#if editing}
				<button type="button" onclick={handleCancel} class="btn btn-ghost btn-sm">Cancel</button>
				<button
					type="button"
					onclick={handleSave}
					disabled={saving || !hasPendingChanges || !pendingUrl}
					class="btn btn-primary btn-sm"
				>
					{saving ? 'Saving…' : 'Save photo'}
				</button>
			{:else}
				{#if committedUrl}
					<button type="button" onclick={handleRemove} class="btn btn-ghost btn-sm">Remove</button>
				{/if}
				<button type="button" onclick={() => fileInput?.click()} class="btn btn-secondary btn-sm">
					{committedUrl ? 'Change' : 'Upload'}
				</button>
			{/if}
		</div>
	</div>
{:else}
	{@render photo()}

	<!-- Zoom slider (visible while editing OR when a photo is committed) -->
	{#if pendingUrl}
		<div class="w-full flex items-center gap-2 px-1">{@render zoom()}</div>
	{/if}

	{@render children?.()}

	<!-- Save / Cancel / Remove buttons -->
	{#if editing}
		<div class="w-full flex items-center gap-2">
			<button type="button" onclick={handleCancel} class="btn btn-ghost btn-sm flex-1">Cancel</button>
			<button
				type="button"
				onclick={handleSave}
				disabled={saving || !hasPendingChanges || !pendingUrl}
				class="btn btn-primary btn-sm flex-1"
			>
				{saving ? 'Saving…' : 'Save'}
			</button>
		</div>
	{:else if committedUrl}
		<button
			type="button"
			onclick={handleRemove}
			class="text-xs text-text-tertiary hover:text-text transition-colors cursor-pointer"
		>
			Remove photo
		</button>
	{/if}
{/if}
