<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import { pageTitle } from '$lib/utils/title';
	import {
		userState,
		createSignature,
		updateSignature,
		deleteSignature,
		setIdentitySignature,
		clearIdentitySignature,
		refreshIdentities,
		type SignatureValue
	} from '$lib/stores/userState';
	import { showToast } from '$lib/stores/toast';
	import SignatureEditor from '$lib/components/SignatureEditor.svelte';

	let refreshing = $state(false);
	const identities = $derived($userState.identities);
	const identityOverrides = $derived($userState.identitySignatures);

	async function pickIdentitySignature(identityId: string, raw: string) {
		try {
			if (raw === '') {
				await clearIdentitySignature(identityId);
			} else {
				await setIdentitySignature(identityId, parseInt(raw, 10));
			}
		} catch {
			showToast({ message: 'Could not save override' });
		}
	}

	async function refreshIdentitiesNow() {
		refreshing = true;
		try {
			const list = await refreshIdentities();
			showToast({ message: `Refreshed — ${list.length} identit${list.length === 1 ? 'y' : 'ies'}` });
		} catch {
			showToast({ message: 'Refresh failed' });
		} finally {
			refreshing = false;
		}
	}

	const MAX_CHARS = 5000;

	type Selection = { kind: 'existing'; id: number } | { kind: 'new' } | null;

	let selection = $state<Selection>(null);
	let draftName = $state('');
	let draftHtml = $state('');
	let saving = $state(false);

	const signatures = $derived($userState.signatures);

	const selectedSignature = $derived.by<SignatureValue | null>(() => {
		const sel = selection;
		if (sel?.kind === 'existing') {
			return signatures.find((s) => s.id === sel.id) ?? null;
		}
		return null;
	});

	const isNew = $derived(selection?.kind === 'new');

	// Char count from a stripped-text approximation; the editor itself shows
	// the authoritative count, but we need it here to gate the Save button
	// independently of the editor instance.
	const draftTextLength = $derived(stripTags(draftHtml).length);
	const overLimit = $derived(draftTextLength > MAX_CHARS);

	const isDirty = $derived.by(() => {
		if (isNew) {
			return draftName.trim().length > 0 || stripTags(draftHtml).trim().length > 0;
		}
		if (!selectedSignature) return false;
		return draftName !== selectedSignature.name || draftHtml !== selectedSignature.html;
	});

	const canSave = $derived(
		!saving && draftName.trim().length > 0 && !overLimit && (isNew ? isDirty : isDirty)
	);

	function stripTags(s: string): string {
		return s.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ');
	}

	// Selecting an existing signature loads it into the editor. Picking
	// "new" seeds a draft we can save into a brand new row.
	function selectExisting(id: number) {
		const sig = signatures.find((s) => s.id === id);
		if (!sig) return;
		selection = { kind: 'existing', id };
		draftName = sig.name;
		draftHtml = sig.html;
	}

	function startNew() {
		selection = { kind: 'new' };
		draftName = 'New signature';
		draftHtml = '<p></p>';
	}

	function cancelEdit() {
		if (isNew) {
			selection = null;
			draftName = '';
			draftHtml = '';
			return;
		}
		if (!selectedSignature) return;
		draftName = selectedSignature.name;
		draftHtml = selectedSignature.html;
	}

	async function save() {
		if (!canSave) return;
		saving = true;
		try {
			if (isNew) {
				const created = await createSignature(draftName.trim(), draftHtml, false);
				selection = { kind: 'existing', id: created.id };
				showToast({ message: 'Signature created' });
			} else if (selection?.kind === 'existing') {
				await updateSignature(selection.id, { name: draftName.trim(), html: draftHtml });
				showToast({ message: 'Signature saved' });
			}
		} catch (err) {
			console.error('signature save failed', err);
			showToast({ message: 'Could not save signature' });
		} finally {
			saving = false;
		}
	}

	async function setDefault() {
		if (selection?.kind !== 'existing') return;
		try {
			await updateSignature(selection.id, { isDefault: true });
			showToast({ message: 'Default signature updated' });
		} catch {
			showToast({ message: 'Could not set default' });
		}
	}

	async function remove() {
		if (selection?.kind !== 'existing') return;
		const sig = selectedSignature;
		if (!sig) return;
		if (!confirm(`Delete "${sig.name}"? This can't be undone.`)) return;
		try {
			await deleteSignature(sig.id);
			selection = null;
			draftName = '';
			draftHtml = '';
		} catch {
			showToast({ message: 'Could not delete signature' });
		}
	}
</script>

<svelte:head><title>{pageTitle({ page: 'Signatures', subtitle: 'Settings' })}</title></svelte:head>

<header class="mb-6 flex items-start justify-between gap-4">
	<div>
		<h1 class="text-xl font-semibold text-text">Signatures</h1>
		<p class="text-sm text-text-tertiary mt-1 max-w-prose">
			Create one or more signatures and pick a default. The default is auto-inserted into new
			messages; you can switch signatures from the composer at any time.
		</p>
	</div>
	<button
		type="button"
		onclick={startNew}
		class="btn btn-primary shrink-0"
	>
		<Icon name="add" size={14} />
		New signature
	</button>
</header>

<div class="grid grid-cols-[220px_1fr] max-md:grid-cols-1 gap-6">
	<!-- List -->
	<aside class="flex flex-col gap-1">
		{#if signatures.length === 0 && !isNew}
			<p class="text-xs text-text-tertiary px-2 py-3">No signatures yet. Create your first one.</p>
		{:else}
			{#each signatures as sig (sig.id)}
				<button
					type="button"
					onclick={() => selectExisting(sig.id)}
					class="text-left px-3 py-2 rounded-lg border-l-2 transition-colors cursor-pointer
						{selection?.kind === 'existing' && selection.id === sig.id
							? 'bg-accent/10 border-l-accent text-text'
							: 'border-l-transparent text-text-secondary hover:bg-surface-hover hover:text-text'}"
				>
					<div class="flex items-center gap-2">
						<span class="flex-1 truncate text-sm">{sig.name}</span>
						{#if sig.isDefault}
							<span class="text-3xs uppercase tracking-wider px-1.5 py-0.5 rounded-md bg-accent/15 text-accent-fg shrink-0">
								Default
							</span>
						{/if}
					</div>
				</button>
			{/each}
		{/if}
		{#if isNew}
			<div class="px-3 py-2 rounded-lg border-l-2 border-l-accent bg-accent/10 text-sm text-text">
				New signature
			</div>
		{/if}
	</aside>

	<!-- Editor pane -->
	<section>
		{#if !selection}
			<div class="rounded-xl border border-dashed border-border bg-surface-hover/20 p-10 text-center text-sm text-text-tertiary">
				Select a signature from the list, or create a new one.
			</div>
		{:else}
			<div class="flex flex-col gap-4">
				<label class="block">
					<span class="text-xs font-medium text-text-secondary block mb-1.5">Name</span>
					<input
						bind:value={draftName}
						placeholder="Signature name"
						maxlength="80"
						class="w-full bg-surface-hover border border-border rounded-lg px-2.5 py-1.5 text-sm text-text placeholder-text-tertiary outline-none focus:border-accent transition-colors"
					/>
				</label>

				<div>
					<span class="text-xs font-medium text-text-secondary block mb-1.5">Content</span>
					<SignatureEditor bind:html={draftHtml} disabled={saving} />
					{#if overLimit}
						<p class="text-xs text-danger mt-1.5">
							Signature is over the {MAX_CHARS.toLocaleString()}-character limit. Trim it before saving.
						</p>
					{/if}
				</div>

				<div class="flex items-center gap-2 pt-2 border-t border-border">
					<button
						type="button"
						onclick={save}
						disabled={!canSave}
						class="btn btn-primary"
					>
						{saving ? 'Saving…' : isNew ? 'Create' : 'Save'}
					</button>
					{#if selection?.kind === 'existing'}
						{#if selectedSignature?.isDefault}
							<span class="text-xs uppercase tracking-wider px-2.5 py-1.5 rounded-lg bg-accent/10 text-accent-fg">
								Default
							</span>
						{:else}
							<button
								type="button"
								onclick={setDefault}
								class="btn btn-secondary"
							>
								Set as default
							</button>
						{/if}
					{/if}
					<div class="flex-1"></div>
					{#if isDirty}
						<button
							type="button"
							onclick={cancelEdit}
							class="text-sm text-text-tertiary hover:text-text px-3 py-1.5 rounded-lg transition-colors cursor-pointer"
						>
							Cancel
						</button>
					{/if}
					{#if selection?.kind === 'existing'}
						<button
							type="button"
							onclick={remove}
							class="btn btn-danger"
						>
							Delete
						</button>
					{/if}
				</div>
			</div>
		{/if}
	</section>
</div>

{#if identities.length > 1 && signatures.length > 0}
	<section class="mt-10 pt-6 border-t border-border">
		<header class="mb-4 flex items-start justify-between gap-4">
			<div>
				<h2 class="text-base font-semibold text-text">Default signatures per identity</h2>
				<p class="text-sm text-text-tertiary mt-1 max-w-prose">
					For each address, pick the signature that auto-applies when you compose from it. Anything
					left on "Use global default" follows the default chosen above.
				</p>
			</div>
			<button
				type="button"
				onclick={refreshIdentitiesNow}
				disabled={refreshing}
				class="btn btn-secondary shrink-0"
			>
				{refreshing ? 'Refreshing…' : 'Refresh from server'}
			</button>
		</header>

		<div class="flex flex-col gap-2">
			{#each identities as identity (identity.jmapId)}
				<div class="flex items-center gap-3 px-3 py-2 rounded-lg bg-surface-hover/50 border border-border/60">
					<div class="flex-1 min-w-0">
						<div class="text-sm text-text truncate">{identity.email}</div>
						{#if identity.name}
							<div class="text-xs text-text-tertiary truncate">{identity.name}</div>
						{/if}
					</div>
					{#if identity.isPrimary}
						<span class="text-3xs uppercase tracking-wider px-1.5 py-0.5 rounded-md bg-accent/15 text-accent-fg shrink-0">
							Primary
						</span>
					{/if}
					<select
						value={identityOverrides.get(identity.jmapId)?.toString() ?? ''}
						onchange={(e) => pickIdentitySignature(identity.jmapId, (e.target as HTMLSelectElement).value)}
						aria-label="Default signature for {identity.email}"
						class="bg-surface border border-border rounded-md px-2 py-1 text-sm text-text outline-none focus:border-accent transition-colors cursor-pointer max-w-[220px]"
					>
						<option value="">— Use global default —</option>
						{#each signatures as sig (sig.id)}
							<option value={sig.id.toString()}>{sig.name}</option>
						{/each}
					</select>
				</div>
			{/each}
		</div>
	</section>
{:else if identities.length > 1 && signatures.length === 0}
	<section class="mt-10 pt-6 border-t border-border">
		<p class="text-sm text-text-tertiary">
			Create a signature above before assigning per-identity defaults.
		</p>
	</section>
{/if}
