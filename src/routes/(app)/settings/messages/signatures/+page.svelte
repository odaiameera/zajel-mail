<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import PageHeader from '$lib/components/settings/PageHeader.svelte';
	import { pageTitle } from '$lib/utils/title';
	import {
		userState,
		createSignature,
		updateSignature,
		deleteSignature,
		type SignatureValue
	} from '$lib/stores/userState';
	import { showToast } from '$lib/stores/toast';
	import SignatureEditor from '$lib/components/SignatureEditor.svelte';
	import IdentityDefaults from './IdentityDefaults.svelte';

	const identities = $derived($userState.identities);

	const MAX_CHARS = 5000;
	// What a new signature is called until it is given a name.
	const NEW_NAME = 'New signature';

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

	// The editor keeps its own Save button. Opening another signature (or a
	// new one) replaces what is in it, so edits that were never saved are
	// asked about first. A new signature nobody has typed in isn't an edit.
	const hasUnsavedEdits = $derived(
		isNew ? draftName !== NEW_NAME || stripTags(draftHtml).trim().length > 0 : isDirty
	);

	function mayReplaceEditor(): boolean {
		return !hasUnsavedEdits || confirm('This signature has unsaved changes. Discard them?');
	}

	// Selecting an existing signature loads it into the editor. Picking
	// "new" seeds a draft we can save into a brand new row.
	function selectExisting(id: number) {
		const sig = signatures.find((s) => s.id === id);
		if (!sig) return;
		if (!mayReplaceEditor()) return;
		selection = { kind: 'existing', id };
		draftName = sig.name;
		draftHtml = sig.html;
	}

	function startNew() {
		if (!mayReplaceEditor()) return;
		selection = { kind: 'new' };
		draftName = NEW_NAME;
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

<PageHeader title="Signatures">
	{#snippet actions()}
		<button type="button" onclick={startNew} class="btn btn-secondary">
			<Icon name="add" size={14} />
			New signature
		</button>
	{/snippet}
</PageHeader>

<div class="grid grid-cols-[220px_1fr] max-md:grid-cols-1 gap-6 mb-8">
	<!-- List: the default one carries a check mark -->
	<aside class="flex flex-col gap-0.5">
		{#if signatures.length === 0 && !isNew}
			<p class="text-sm text-text-tertiary px-3 py-2">No signatures</p>
		{:else}
			{#each signatures as sig (sig.id)}
				<button
					type="button"
					onclick={() => selectExisting(sig.id)}
					class="flex items-center gap-2 text-left h-[34px] px-3 rounded-lg text-sm transition-colors cursor-pointer
						{selection?.kind === 'existing' && selection.id === sig.id
							? 'bg-accent/10 text-accent-fg font-medium'
							: 'text-text-secondary hover:bg-surface-hover hover:text-text'}"
				>
					<span class="flex-1 truncate">{sig.name}</span>
					{#if sig.isDefault}
						<Icon name="check" size={14} aria-label="Default" />
					{/if}
				</button>
			{/each}
		{/if}
		{#if isNew}
			<div class="flex items-center h-[34px] px-3 rounded-lg bg-accent/10 text-sm font-medium text-accent-fg">New signature</div>
		{/if}
	</aside>

	<!-- Editor pane -->
	<section>
		{#if !selection}
			<div class="rounded-xl border border-dashed border-border p-10 text-center text-sm text-text-tertiary">
				No signature selected
			</div>
		{:else}
			<!-- The editor has a Save of its own, so Cmd/Ctrl+S in it isn't the bar's. -->
			<div class="flex flex-col gap-4" data-own-save>
				<label class="block">
					<span class="text-[0.8125rem] font-semibold text-text-tertiary block mb-1.5">Name</span>
					<input
						bind:value={draftName}
						placeholder="Signature name"
						maxlength="80"
						class="w-full h-8.5 bg-transparent border border-border rounded-md px-2.5 text-sm text-text placeholder-text-tertiary outline-none focus:border-accent transition-colors"
					/>
				</label>

				<div>
					<span class="text-[0.8125rem] font-semibold text-text-tertiary block mb-1.5">Content</span>
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
						{#if !selectedSignature?.isDefault}
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
	<IdentityDefaults />
{/if}
