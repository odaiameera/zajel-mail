<script lang="ts">
	import { untrack } from 'svelte';
	import Icon from '$lib/components/Icon.svelte';
	import { invalidateAll } from '$app/navigation';
	import { pageTitle } from '$lib/utils/title';
	import PageHeader from '$lib/components/settings/PageHeader.svelte';
	import Section from '$lib/components/settings/Section.svelte';
	import SettingRow from '$lib/components/settings/SettingRow.svelte';
	import TextInput from '$lib/components/settings/TextInput.svelte';
	import RowMenu from '$lib/components/settings/RowMenu.svelte';
	import ProfilePhotoEditor from '$lib/components/ProfilePhotoEditor.svelte';
	import { useDraft } from '$lib/settings/draft.svelte';
	import { sendJson } from '$lib/settings/send';
	import { reordered, sortable, type SortMove } from '$lib/actions/sortable';
	import { fetchWithStepUp } from '$lib/auth/step-up';
	import ColorGrid from '$lib/components/modals/ColorGrid.svelte';
	import { colorByHex, DEFAULT_LABEL_COLOR } from '$lib/constants/colors';
	import { fileToAvatarDataUrl } from '$lib/utils/image';
	import type { LayoutData } from '../$types';

	let { data }: { data: LayoutData } = $props();

	const accounts = $derived(data.accounts ?? []);
	const activeAccountId = $derived(data.activeAccountId);

	// --- You: the name is stored when Save is pressed; the photo saves itself ---
	const draft = useDraft({
		// What the page opened with; later reloads of `data` leave the form alone.
		initial: untrack(() => ({ displayName: data.displayName })),
		async persist(_changed, all) {
			await sendJson('/api/preferences/settings', { displayName: all.displayName });
			// The header shows the name too.
			await invalidateAll();
			// The server stores it without the spaces around it.
			return { displayName: all.displayName.trim() };
		}
	});
	const letter = $derived((draft.value.displayName.trim() || accounts[0]?.email || 'O')[0].toUpperCase());

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
	let addPasswordEl = $state<HTMLInputElement | null>(null);
	// Set while the dialog is signing an account that is already linked in
	// again: linking its address a second time refreshes the stored password
	// and leaves everything else about it as it is.
	let reconnecting = $state(false);

	const addColorName = $derived(colorByHex(addColor.hex).name);

	// --- Per-row state ---
	let confirmRemoveId = $state<string | null>(null);
	// What unlinking the account under confirm would take with it (GET /api/accounts/[id]).
	type UnlinkLosses = { pendingSends: number; enabledJobs: number; searchIndexed: boolean; rules: number };
	let removeLosses = $state<UnlinkLosses | null>(null);
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
		reconnecting = false;
		adding = true;
		setTimeout(() => addEmailEl?.focus(), 0);
	}

	function openReconnect(email: string) {
		openAdd();
		addEmail = email;
		reconnecting = true;
		setTimeout(() => addPasswordEl?.focus(), 0);
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
			const res = await fetchWithStepUp('/api/accounts', {
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

	/** Open the confirm, then add what the server says would go with the link. */
	async function askRemove(id: string) {
		confirmRemoveId = id;
		removeLosses = null;
		try {
			const res = await fetch(`/api/accounts/${id}`);
			if (res.ok && confirmRemoveId === id) removeLosses = (await res.json()).unlink;
		} catch {
			// The confirm still works without the counts.
		}
	}

	/** "2 scheduled emails won’t be sent, 1 job stops, 3 rules are deleted, the search index goes", or '' when nothing would. */
	function lossSummary(losses: UnlinkLosses): string {
		const parts: string[] = [];
		if (losses.pendingSends > 0) {
			parts.push(`${losses.pendingSends} scheduled ${losses.pendingSends === 1 ? 'email' : 'emails'} won’t be sent`);
		}
		if (losses.enabledJobs > 0) parts.push(`${losses.enabledJobs} ${losses.enabledJobs === 1 ? 'job stops' : 'jobs stop'}`);
		if (losses.rules > 0) parts.push(`${losses.rules} ${losses.rules === 1 ? 'rule is' : 'rules are'} deleted`);
		if (losses.searchIndexed) parts.push('the search index goes');
		return parts.join(', ');
	}

	async function removeAccount(id: string) {
		if (rowBusy) return;
		rowBusy = true;
		try {
			const res = await fetchWithStepUp(`/api/accounts/${id}`, { method: 'DELETE' });
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

	/** A row dragged to a new place, or moved with the arrow keys on its handle. */
	async function moveAccount(move: SortMove) {
		const before = accounts.map((a) => a.id);
		const ids = reordered(before, move);
		if (ids.join() === before.join()) return;
		const res = await fetch('/api/accounts/reorder', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ ids })
		});
		if (res.ok) await invalidateAll();
	}
</script>

<svelte:head><title>{pageTitle({ page: 'Accounts', subtitle: 'Settings' })}</title></svelte:head>

<PageHeader title="Accounts" />

<Section title="You" id="you">
	<ProfilePhotoEditor variant="row" {letter} />
	<SettingRow title="Name">
		{#snippet control()}
			<TextInput bind:value={draft.value.displayName} ariaLabel="Name" placeholder="Your name" maxlength={120} width="240px" />
		{/snippet}
	</SettingRow>
</Section>

<Section title="Mail accounts" id="mail-accounts">
	{#snippet action()}
		<button type="button" onclick={openAdd} class="btn btn-secondary btn-sm">
			<Icon name="add" size={14} />
			Add account
		</button>
	{/snippet}

	<!-- The first one opens when you sign in: drag a row by its handle, or
	     use the arrow keys on it, to change the order. -->
	<div class="divide-y divide-border" use:sortable={{ onMove: moveAccount, disabled: accounts.length < 2 }}>
		{#each accounts as account (account.id)}
			{@const isActive = account.id === activeAccountId}
			{@const name = account.displayName || account.email}
			<div data-sort-id={account.id} class="relative flex items-center gap-3 min-h-16 pl-2 pr-3 py-2 max-md:pr-2">
				<button
					type="button"
					data-sort-handle
					aria-label="Reorder {name}"
					disabled={accounts.length < 2}
					class="w-6 h-9 max-md:h-11 shrink-0 flex items-center justify-center rounded-md text-text-tertiary hover:text-text disabled:opacity-30 disabled:cursor-default"
				>
					<Icon name="reorder" size={16} />
				</button>

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
						class="w-9 h-9 rounded-full overflow-hidden flex items-center justify-center text-white text-sm font-semibold cursor-pointer transition-shadow hover:ring-2 hover:ring-offset-2 hover:ring-offset-bg"
						style="background-color: {account.color}; --tw-ring-color: {account.color};"
					>
						{#if avatarMissing[account.id]}
							{name[0]?.toUpperCase()}
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
							<p class="text-xs font-medium text-text-secondary mb-2.5">Color</p>
							<ColorGrid value={colorByHex(account.color)} onChange={(c) => setColor(account.id, c.hex)} />
						</div>
					{/if}
				</div>

				<div class="flex-1 min-w-0">
					{#if editingNameId === account.id}
						<input
							bind:this={nameInputEl}
							bind:value={nameDraft}
							onblur={() => commitRename(account.id)}
							onkeydown={(e) => handleNameKeydown(e, account.id)}
							placeholder={account.email}
							aria-label="Account name"
							class="w-full min-w-0 h-8 bg-transparent border border-accent rounded-md px-2 text-sm text-text placeholder-text-tertiary outline-none"
						/>
					{:else}
						<p class="text-sm font-medium text-text truncate">{name}</p>
						{#if account.needsReauth}
							<p class="text-[0.8125rem] text-danger truncate">Sign in again</p>
						{:else if account.displayName}
							<p class="text-[0.8125rem] text-text-tertiary truncate">{account.email}</p>
						{/if}
					{/if}
				</div>

				{#if confirmRemoveId === account.id}
					<!-- Unlinking takes things with it: say which, then ask. -->
					<div class="flex flex-wrap items-center justify-end gap-2">
						<span class="text-[0.8125rem] text-text-secondary">
							Unlink this account?
							{#if removeLosses && lossSummary(removeLosses)}
								<span class="block text-danger">{lossSummary(removeLosses)}.</span>
							{/if}
						</span>
						<button type="button" disabled={rowBusy} onclick={() => removeAccount(account.id)} class="btn btn-danger-solid btn-sm">
							Unlink
						</button>
						<button type="button" onclick={() => (confirmRemoveId = null)} class="btn btn-ghost btn-sm">Cancel</button>
					</div>
				{:else}
					{#if account.needsReauth}
						<button type="button" onclick={() => openReconnect(account.email)} class="btn btn-secondary btn-sm shrink-0">
							Reconnect
						</button>
					{/if}
					{#if isActive}
						<!-- The account in use, in place of a tag saying so. -->
						<Icon name="check" size={16} class="text-accent-fg mx-1" aria-label="In use" />
					{/if}
					<RowMenu
						ariaLabel="{name} options"
						items={[
							...(isActive ? [] : [{ label: 'Switch to', onSelect: () => makeActive(account.id) }]),
							{ label: 'Rename', onSelect: () => startRename(account.id, account.displayName ?? '') },
							{ label: 'Photo and color', onSelect: () => (colorPickerId = account.id) },
							{ label: 'Unlink', danger: true, disabled: accounts.length === 1, onSelect: () => askRemove(account.id) }
						]}
					/>
				{/if}
			</div>
		{/each}
	</div>
</Section>

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
				<h2 id="link-account-title" class="text-lg font-semibold text-text">
					{reconnecting ? 'Reconnect' : 'Link a mail account'}
				</h2>
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
				The password is checked with the mail server, then kept encrypted here so rules and
				reminders keep running in the background.
			</p>

			<div class="space-y-5">
				<div>
					<label class="block text-sm font-medium text-text mb-2" for="link-email">Email address</label>
					<input
						id="link-email"
						bind:value={addEmail}
						bind:this={addEmailEl}
						readonly={reconnecting}
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
						bind:this={addPasswordEl}
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
					</div>
				{:else}
					<button type="button" onclick={() => (showServerUrl = true)}
						class="text-xs text-text-tertiary hover:text-text transition-colors cursor-pointer">
						Different mail server?
					</button>
				{/if}

				{#if !reconnecting}
					<div>
						<div class="flex items-baseline gap-2 mb-3">
							<span class="text-sm font-medium text-text">Color:</span>
							<span class="text-sm text-text-secondary">{addColorName}</span>
						</div>
						<ColorGrid value={addColor} onChange={(c) => (addColor = c)} />
					</div>
				{/if}

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
					{addBusy ? 'Verifying…' : reconnecting ? 'Reconnect' : 'Link account'}
				</button>
			</div>
		</div>
	</div>
{/if}
