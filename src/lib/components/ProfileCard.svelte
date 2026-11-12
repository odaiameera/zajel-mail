<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import { goto } from '$app/navigation';
	import ProfilePhotoEditor from '$lib/components/ProfilePhotoEditor.svelte';
	import type { LinkedAccount } from '$lib/types/accounts';
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

	const avatarLetter = $derived(displayName[0]?.toUpperCase() ?? 'O');
	let editing = $state(false);
	let photoEditor = $state<ProfilePhotoEditor | null>(null);

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			if (editing) photoEditor?.cancel();
			else onClose();
		}
	}
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="w-72 bg-surface border border-border rounded-2xl shadow-[0_8px_32px_rgba(0,0,0,0.4)] overflow-hidden animate-compose-modal-in">
	<!-- Avatar section -->
	<div class="flex flex-col items-center pt-6 pb-4 px-4 gap-3">
		<ProfilePhotoEditor bind:this={photoEditor} bind:editing letter={avatarLetter} color={accountColor}>
			<div class="text-center">
				<p class="text-sm font-semibold text-text">{displayName}</p>
				<p class="text-xs text-text-tertiary mt-0.5">{email}</p>
			</div>
		</ProfilePhotoEditor>
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
