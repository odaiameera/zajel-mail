<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import { invalidateAll } from '$app/navigation';
	import { pageTitle } from '$lib/utils/title';
	import ColorGrid from '$lib/components/modals/ColorGrid.svelte';
	import { colorByHex, DEFAULT_LABEL_COLOR } from '$lib/constants/colors';
	import { fileToAvatarDataUrl } from '$lib/utils/image';
	import type { LayoutData } from '../$types';

	let { data }: { data: LayoutData } = $props();

	const accounts = $derived(data.accounts ?? []);
	const activeAccountId = $derived(data.activeAccountId);

	// --- Add account modal ---
	let adding = $state(false);
	let addEmail = $state('');
	let addPassword = $state('');
	let addColor = $state(DEFAULT_LABEL_COLOR);
	let addServerUrl = $state('');
	let showServerUrl = $state(false);
	let addBusy = $state(false);
	let addError = $state<string | null>(null);
	let addEmailEl = $state<HTMLInputElement | null>(null);

	const addColorName = $derived(colorByHex(addColor.hex).name);

	// --- Per-row state ---
	let confirmRemoveId = $state<string | null>(null);
	let colorPickerId = $state<string | null>(null);
	let rowBusy = $state(false);

	// Inline rename.
	let editingNameId = $state<string | null>(null);
	let nameDraft = $state('');
	let nameInputEl = $state<HTMLInputElement | null>(null);

	/**
	 * The avatar endpoint falls back to BIMI/favicon/Gravatar when nothing has
	 * been uploaded, so we just point an <img> at it and let a 404 mean "draw
	 * the initial instead". `avatarVersion` busts the browser cache after an
	 * upload or removal, since the URL itself never changes.
	 */
	let avatarVersion = $state<Record<string, number>>({});
	let avatarMissing = $state<Record<string, boolean>>({});
	let avatarBusyId = $state<string | null>(null);
	let fileInputs: Record<string, HTMLInputElement | null> = {};

	function avatarSrc(id: string): string {
		return `/api/accounts/${id}/avatar?v=${avatarVersion[id] ?? 0}`;
	}

	function refreshAvatar(id: string) {
		avatarVersion = { ...avatarVersion, [id]: (avatarVersion[id] ?? 0) + 1 };
		avatarMissing = { ...avatarMissing, [id]: false };
	}

	function startRename(id: string, current: string) {
		editingNameId = id;
		nameDraft = current;
		setTimeout(() => nameInputEl?.focus(), 0);
	}

	async function commitRename(id: string) {
		const next = nameDraft.trim();
		editingNameId = null;
		await fetch(`/api/accounts/${id}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ displayName: next })
		});
		await invalidateAll();
	}

	function handleNameKeydown(e: KeyboardEvent, id: string) {
		if (e.key === 'Enter') {
			e.preventDefault();
			commitRename(id);
		} else if (e.key === 'Escape') {
			e.preventDefault();
			editingNameId = null;
		}
	}

	async function uploadAvatar(id: string, file: File) {
		avatarBusyId = id;
		try {
			const data = await fileToAvatarDataUrl(file);
			const res = await fetch(`/api/accounts/${id}/avatar`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ data })
			});
			if (res.ok) refreshAvatar(id);
		} finally {
			avatarBusyId = null;
		}
	}

	async function removeAvatar(id: string) {
		avatarBusyId = id;
		try {
			const res = await fetch(`/api/accounts/${id}/avatar`, { method: 'DELETE' });
			// The resolver fallback may still supply one, so re-fetch rather
			// than assuming the circle is now empty.
			if (res.ok) refreshAvatar(id);
		} finally {
			avatarBusyId = null;
		}
	}

	function openAdd() {
		addEmail = '';
		addPassword = '';
		addServerUrl = '';
		addColor = DEFAULT_LABEL_COLOR;
		showServerUrl = false;
		addError = null;
		adding = true;
		setTimeout(() => addEmailEl?.focus(), 0);
	}

	function closeAdd() {
		if (addBusy) return;
		adding = false;
	}

	function handleModalKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault();
			closeAdd();
		} else if (e.key === 'Enter' && (e.target as HTMLElement)?.tagName === 'INPUT') {
			e.preventDefault();
			addAccount();
		}
	}

	async function addAccount() {
		if (!addEmail || !addPassword || addBusy) return;
		addBusy = true;
		addError = null;
		try {
			const res = await fetch('/api/accounts', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					email: addEmail,
					password: addPassword,
					color: addColor.hex,
					...(addServerUrl.trim() ? { serverUrl: addServerUrl.trim() } : {})
				})
			});
			if (!res.ok) {
				const body = await res.json().catch(() => null);
				addError = body?.message ?? 'Could not link the account';
				return;
			}
			adding = false;
			await invalidateAll();
		} catch {
			addError = 'Could not reach the server';
		} finally {
			addBusy = false;
		}
	}

	async function removeAccount(id: string) {
		if (rowBusy) return;
		rowBusy = true;
		try {
			const res = await fetch(`/api/accounts/${id}`, { method: 'DELETE' });
			if (res.ok) {
				confirmRemoveId = null;
				await invalidateAll();
			}
		} finally {
			rowBusy = false;
		}
	}

	async function setColor(id: string, hex: string) {
		colorPickerId = null;
		await fetch(`/api/accounts/${id}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ color: hex })
		});
		await invalidateAll();
	}

	async function makeActive(id: string) {
		const res = await fetch('/api/accounts/switch', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ id })
		});
		if (res.ok) await invalidateAll();
	}

	async function move(id: string, dir: -1 | 1) {
		const ids = accounts.map((a) => a.id);
		const i = ids.indexOf(id);
		const j = i + dir;
		if (i < 0 || j < 0 || j >= ids.length) return;
		[ids[i], ids[j]] = [ids[j], ids[i]];
		const res = await fetch('/api/accounts/reorder', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ ids })
		});
		if (res.ok) await invalidateAll();
	}
</script>

<svelte:head><title>{pageTitle({ page: 'Accounts', subtitle: 'Settings' })}</title></svelte:head>

<header class="mb-6 flex items-start justify-between gap-4">
	<div>
		<h1 class="text-xl font-semibold text-text">Accounts</h1>
		<p class="text-sm text-text-tertiary mt-1">
			Mail accounts linked to this webmail. Each account keeps its own labels, rules, signatures,
			reminders, and calendar.
		</p>
	</div>
	<button
		type="button"
		onclick={openAdd}
		class="btn btn-primary shrink-0"
	>
		<Icon name="add" size={14} />
		Add account
	</button>
</header>

<section class="border border-border rounded-xl bg-surface overflow-visible">
	{#each accounts as account, i (account.id)}
		{@const isActive = account.id === activeAccountId}
		<div class="group relative flex items-center gap-3.5 px-4 py-3.5 border-b border-border last:border-b-0">
			<!-- Avatar: uploaded photo, else a resolved one, else the initial -->
			<div class="relative shrink-0">
				<input
					type="file"
					accept="image/*"
					class="hidden"
					bind:this={fileInputs[account.id]}
					onchange={(e) => {
						const file = (e.currentTarget as HTMLInputElement).files?.[0];
						if (file) uploadAvatar(account.id, file);
						(e.currentTarget as HTMLInputElement).value = '';
					}}
				/>
				<button
					type="button"
					title="Change photo or color"
					aria-label="Change photo or color for {account.email}"
					onclick={() => (colorPickerId = colorPickerId === account.id ? null : account.id)}
					class="w-9 h-9 rounded-full overflow-hidden flex items-center justify-center text-white text-sm font-semibold cursor-pointer transition-shadow hover:ring-2 hover:ring-offset-2 hover:ring-offset-surface"
					class:ring-2={isActive}
					class:ring-offset-2={isActive}
					class:ring-offset-surface={isActive}
					style="background-color: {account.color}; --tw-ring-color: {account.color};"
				>
					{#if avatarMissing[account.id]}
						{(account.displayName || account.email)[0]?.toUpperCase()}
					{:else}
						<img
							src={avatarSrc(account.id)}
							alt=""
							class="w-full h-full object-cover"
							onerror={() => (avatarMissing = { ...avatarMissing, [account.id]: true })}
						/>
					{/if}
				</button>
				{#if colorPickerId === account.id}
					<button
						type="button"
						class="fixed inset-0 z-20 cursor-default"
						aria-label="Close appearance picker"
						onclick={() => (colorPickerId = null)}
					></button>
					<div class="absolute z-30 top-11 left-0 w-max rounded-xl border border-border bg-surface p-3.5 shadow-[0_8px_32px_rgba(0,0,0,0.45)]">
						<p class="text-xs font-medium text-text-secondary mb-2.5">Photo</p>
						<div class="flex items-center gap-2 mb-4">
							<button
								type="button"
								disabled={avatarBusyId === account.id}
								onclick={() => fileInputs[account.id]?.click()}
								class="btn btn-secondary btn-sm"
							>
								{avatarBusyId === account.id ? 'Uploading…' : 'Upload'}
							</button>
							<button
								type="button"
								disabled={avatarBusyId === account.id}
								onclick={() => removeAvatar(account.id)}
								class="btn btn-ghost btn-sm text-text-tertiary hover:text-danger"
							>
								Remove
							</button>
						</div>
						<p class="text-3xs text-text-tertiary mb-4 max-w-[15rem] leading-relaxed">
							With no photo uploaded, the account's own avatar is looked up automatically
							and the initial is used only if none is found.
						</p>
						<p class="text-xs font-medium text-text-secondary mb-2.5">Account color</p>
						<ColorGrid value={colorByHex(account.color)} onChange={(c) => setColor(account.id, c.hex)} />
					</div>
				{/if}
			</div>

			<div class="flex-1 min-w-0">
				<div class="flex items-center gap-2 min-w-0">
					{#if editingNameId === account.id}
						<input
							bind:this={nameInputEl}
							bind:value={nameDraft}
							onblur={() => commitRename(account.id)}
							onkeydown={(e) => handleNameKeydown(e, account.id)}
							placeholder={account.email}
							aria-label="Account name"
							class="min-w-0 flex-1 bg-surface-hover border border-accent rounded-md px-2 py-1 text-sm text-text placeholder-text-tertiary outline-none"
						/>
					{:else}
						<button
							type="button"
							title="Rename this account"
							onclick={() => startRename(account.id, account.displayName ?? '')}
							class="min-w-0 text-left text-sm font-medium text-text truncate hover:text-accent-fg transition-colors cursor-pointer"
						>
							{account.displayName || account.email}
						</button>
					{/if}
					{#if isActive}
						<span class="shrink-0 text-3xs font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded-md bg-accent/15 text-accent-fg">Active</span>
					{/if}
					{#if i === 0}
						<span class="shrink-0 text-3xs font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded-md bg-surface-hover text-text-tertiary" title="Opens by default when you sign in">Default</span>
					{/if}
				</div>
				{#if account.displayName && editingNameId !== account.id}
					<p class="text-xs text-text-tertiary truncate mt-0.5">{account.email}</p>
				{/if}
				{#if account.needsReauth}
					<p class="text-xs text-danger mt-0.5">Reconnect required — the mail server rejected the stored password.</p>
				{/if}
			</div>

			<!-- Row actions: quiet until the row is hovered -->
			<div
				class="flex items-center gap-1 opacity-0 group-hover:opacity-100 pointer-coarse:opacity-100 focus-within:opacity-100 transition-opacity"
				class:opacity-100={confirmRemoveId === account.id || colorPickerId === account.id}
			>
				<div class="flex flex-col mr-1">
					<button type="button" aria-label="Move up" disabled={i === 0} onclick={() => move(account.id, -1)}
						class="text-text-tertiary hover:text-text disabled:opacity-30 cursor-pointer disabled:cursor-default p-0.5">
						<Icon name="move-up" size={14} />
					</button>
					<button type="button" aria-label="Move down" disabled={i === accounts.length - 1} onclick={() => move(account.id, 1)}
						class="text-text-tertiary hover:text-text disabled:opacity-30 cursor-pointer disabled:cursor-default p-0.5">
						<Icon name="move-down" size={14} />
					</button>
				</div>

				{#if confirmRemoveId === account.id}
					<span class="text-xs text-text-secondary mr-1">Unlink this account?</span>
					<button type="button" disabled={rowBusy} onclick={() => removeAccount(account.id)}
						class="btn btn-danger-solid btn-sm transition-opacity">
						Unlink
					</button>
					<button type="button" onclick={() => (confirmRemoveId = null)}
						class="btn btn-ghost btn-sm">
						Cancel
					</button>
				{:else}
					<button type="button" title="Remove account" aria-label="Remove account"
						onclick={() => (confirmRemoveId = account.id)}
						disabled={accounts.length === 1}
						class="text-text-tertiary hover:text-danger disabled:opacity-30 disabled:cursor-default transition-colors cursor-pointer p-1.5 rounded-lg hover:bg-surface-hover">
						<Icon name="delete" size={16} />
					</button>
				{/if}
			</div>

			{#if !isActive}
				<button type="button" onclick={() => makeActive(account.id)}
					class="btn btn-secondary btn-sm shrink-0">
					Switch to
				</button>
			{/if}
		</div>
	{/each}
</section>

<p class="mt-4 text-xs text-text-tertiary leading-relaxed">
	Removing an account only unlinks it from the webmail — nothing is deleted on the mail server, and
	its labels, rules, and other data here are restored if you link it again.
</p>

{#if adding}
	<div
		class="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 backdrop-blur-[2px]"
		role="dialog"
		aria-modal="true"
		aria-labelledby="link-account-title"
		tabindex="-1"
		onclick={(e) => {
			if (e.target === e.currentTarget) closeAdd();
		}}
		onkeydown={handleModalKeydown}
	>
		<div
			class="bg-surface border border-border rounded-xl w-full max-w-md mx-4 p-6 shadow-[0_8px_32px_rgba(0,0,0,0.45)]"
			role="document"
		>
			<div class="flex items-start justify-between mb-1">
				<h2 id="link-account-title" class="text-lg font-semibold text-text">Link a mail account</h2>
				<button
					type="button"
					class="text-text-tertiary hover:text-text transition-colors cursor-pointer"
					onclick={closeAdd}
					aria-label="Close"
				>
					<Icon name="close" size={20} />
				</button>
			</div>
			<p class="text-sm text-text-secondary mb-5 leading-relaxed">
				Sign in with the account's mail server credentials. The webmail verifies them, then keeps
				them encrypted so rules and reminders keep running in the background.
			</p>

			<div class="space-y-5">
				<div>
					<label class="block text-sm font-medium text-text mb-2" for="link-email">Email address</label>
					<input
						id="link-email"
						bind:value={addEmail}
						bind:this={addEmailEl}
						type="email"
						placeholder="you@yourdomain.com"
						autocomplete="off"
						class="w-full bg-surface-hover border border-border focus:border-accent rounded-lg px-3 py-2 text-sm text-text placeholder-text-tertiary outline-none transition-colors"
					/>
				</div>

				<div>
					<label class="block text-sm font-medium text-text mb-2" for="link-password">Mail server password</label>
					<input
						id="link-password"
						bind:value={addPassword}
						type="password"
						placeholder="••••••••"
						autocomplete="new-password"
						class="w-full bg-surface-hover border border-border focus:border-accent rounded-lg px-3 py-2 text-sm text-text placeholder-text-tertiary outline-none transition-colors"
					/>
				</div>

				{#if showServerUrl}
					<div>
						<label class="block text-sm font-medium text-text mb-2" for="link-server">Mail server</label>
						<input
							id="link-server"
							bind:value={addServerUrl}
							type="url"
							placeholder="https://mail.example.com"
							class="w-full bg-surface-hover border border-border focus:border-accent rounded-lg px-3 py-2 text-sm text-text placeholder-text-tertiary outline-none transition-colors"
						/>
						<p class="text-xs text-text-tertiary mt-1.5">Leave empty to use your configured server.</p>
					</div>
				{:else}
					<button type="button" onclick={() => (showServerUrl = true)}
						class="text-xs text-text-tertiary hover:text-text transition-colors cursor-pointer">
						Different mail server?
					</button>
				{/if}

				<div>
					<div class="flex items-baseline gap-2 mb-3">
						<span class="text-sm font-medium text-text">Color:</span>
						<span class="text-sm text-text-secondary">{addColorName}</span>
					</div>
					<ColorGrid value={addColor} onChange={(c) => (addColor = c)} />
					<p class="text-xs text-text-tertiary mt-3">
						Shown in the header and account switcher so you always know which inbox is open.
					</p>
				</div>

				{#if addError}
					<div class="text-sm text-danger" aria-live="polite">{addError}</div>
				{/if}
			</div>

			<div class="flex justify-end gap-2 mt-6 pt-4 border-t border-border">
				<button
					type="button"
					class="btn btn-ghost btn-lg"
					onclick={closeAdd}
					disabled={addBusy}
				>
					Cancel
				</button>
				<button
					type="button"
					class="btn btn-primary btn-lg"
					onclick={addAccount}
					disabled={addBusy || !addEmail || !addPassword}
				>
					{#if addBusy}
						<span class="w-3.5 h-3.5 rounded-full border-2 border-white/40 border-t-white animate-spin"></span>
					{/if}
					{addBusy ? 'Verifying…' : 'Link account'}
				</button>
			</div>
		</div>
	</div>
{/if}
