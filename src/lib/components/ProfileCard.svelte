<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { profilePhoto } from '$lib/stores/profilePhoto';
	import type { LinkedAccount } from '$lib/types/accounts';
	import { resizeImage } from '$lib/utils/image';
	import { canLeaveSettings } from '$lib/settings/leave';

	let { displayName, email, accounts = [], activeAccountId = null, accountUnread = {}, onClose }: {
		displayName: string;
		email: string;
		accounts?: LinkedAccount[];
		activeAccountId?: string | null;
		accountUnread?: Record<string, number>;
		onClose: () => void;
	} = $props();

	let switching = $state<string | null>(null);
	const otherAccounts = $derived(accounts.filter((a) => a.id !== activeAccountId));
	// Same rule as the header avatar: an account's own colour only means
	// something once there is another account to tell it apart from.
	const accountColor = $derived(
		accounts.length > 1 ? (accounts.find((a) => a.id === activeAccountId)?.color ?? null) : null
	);

	async function switchAccount(id: string) {
		if (switching) return;
		switching = id;
		try {
			// Unsaved settings belong to the account in use: settle them before
			// it changes, not after (Save would then store them for the new one).
			if (!(await canLeaveSettings())) return;
			const res = await fetch('/api/accounts/switch', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ id })
			});
			if (res.ok) {
				// Land on the inbox of the newly active account with fresh data.
				await goto('/inbox', { invalidateAll: true });
				onClose();
			}
		} finally {
			switching = null;
		}
	}

	async function manageAccounts() {
		onClose();
		await goto('/settings/accounts');
	}

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
	let editing = $state(false);
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

	const avatarLetter = $derived(displayName[0]?.toUpperCase() ?? 'O');
	const hasPendingChanges = $derived(
		editing && (
			pendingUrl !== committedUrl ||
			pendingZoom !== committedZoom ||
			pendingOffsetX !== committedOffsetX ||
			pendingOffsetY !== committedOffsetY
		)
	);

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			if (editing) handleCancel();
			else onClose();
		}
	}
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="w-72 bg-surface border border-border rounded-2xl shadow-[0_8px_32px_rgba(0,0,0,0.4)] overflow-hidden animate-compose-modal-in">
	<!-- Avatar section -->
	<div class="flex flex-col items-center pt-6 pb-4 px-4 gap-3">
		<button
			bind:this={avatarEl}
			onclick={handlePhotoClick}
			onpointerdown={onPointerDown}
			onpointermove={onPointerMove}
			onpointerup={onPointerUp}
			onpointercancel={onPointerUp}
			class="relative w-20 h-20 rounded-full overflow-hidden group bg-accent touch-none
				{pendingUrl ? (dragging ? 'cursor-grabbing' : 'cursor-grab') : 'cursor-pointer'}"
			style={accountColor ? `background-color: ${accountColor}` : undefined}
			title={pendingUrl ? 'Drag to reposition, click to change' : 'Click to upload'}
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
					{avatarLetter}
				</div>
			{/if}
			<div class="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center pointer-events-none">
				<Icon name="photo" size={20} />
			</div>
		</button>
		<input bind:this={fileInput} type="file" accept="image/*" class="hidden" onchange={handleFileChange} />

		<!-- Zoom slider (visible while editing OR when a photo is committed) -->
		{#if pendingUrl}
			<div class="w-full flex items-center gap-2 px-1">
				<Icon name="zoom-out" size={14} class="text-text-tertiary" />
				<input
					type="range"
					min={MIN_ZOOM}
					max={MAX_ZOOM}
					step="0.01"
					bind:value={pendingZoom}
					oninput={() => { editing = true; }}
					class="flex-1 accent-accent cursor-pointer"
					title="Zoom"
				/>
				<Icon name="zoom-in" size={16} class="text-text-tertiary" />
			</div>
		{/if}

		<div class="text-center">
			<p class="text-sm font-semibold text-text">{displayName}</p>
			<p class="text-xs text-text-tertiary mt-0.5">{email}</p>
		</div>

		<!-- Save / Cancel / Remove buttons -->
		{#if editing}
			<div class="w-full flex items-center gap-2">
				<button
					type="button"
					onclick={handleCancel}
					class="btn btn-ghost btn-sm flex-1"
				>
					Cancel
				</button>
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
	</div>

	<div class="border-t border-border"></div>

	<!-- Account switcher -->
	{#if otherAccounts.length > 0}
		<div class="p-2">
			{#each otherAccounts as account (account.id)}
				<button
					type="button"
					onclick={() => switchAccount(account.id)}
					disabled={switching !== null}
					class="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm text-text-secondary
						hover:text-text hover:bg-surface-hover transition-colors cursor-pointer text-left
						disabled:opacity-60 disabled:cursor-wait"
				>
					<span
						class="w-7 h-7 rounded-full shrink-0 flex items-center justify-center text-white text-2xs font-semibold"
						style="background-color: {account.color}"
					>
						{account.email[0]?.toUpperCase()}
					</span>
					<span class="flex-1 min-w-0">
						<span class="block truncate">{account.displayName ?? account.email.split('@')[0]}</span>
						<span class="block truncate text-xs text-text-tertiary">{account.email}</span>
					</span>
					{#if account.needsReauth}
						<span class="text-3xs text-danger shrink-0" title="Reconnect required">!</span>
					{:else if accountUnread[account.id]}
						<span class="shrink-0 min-w-5 h-5 px-1.5 rounded-full bg-accent/15 text-accent-fg text-2xs font-semibold flex items-center justify-center">
							{accountUnread[account.id] > 99 ? '99+' : accountUnread[account.id]}
						</span>
					{/if}
				</button>
			{/each}
		</div>
		<div class="border-t border-border"></div>
	{/if}

	<!-- Actions -->
	<div class="p-2">
		<button
			type="button"
			onclick={manageAccounts}
			class="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm text-text-secondary hover:text-text hover:bg-surface-hover transition-colors cursor-pointer text-left"
		>
			<Icon name="sign-in" size={16} />
			Add or manage accounts
		</button>
		<form method="POST" action="/logout">
			<button
				type="submit"
				class="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm text-text-secondary hover:text-text hover:bg-surface-hover transition-colors cursor-pointer text-left"
			>
				<Icon name="sign-out" size={16} />
				Sign out
			</button>
		</form>
	</div>
</div>
