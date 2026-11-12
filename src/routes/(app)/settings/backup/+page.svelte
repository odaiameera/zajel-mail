<script lang="ts">
	import { pageTitle } from '$lib/utils/title';
	import { invalidateAll } from '$app/navigation';
	import { PREFERENCES } from '$lib/preference-keys';
	import PageHeader from '$lib/components/settings/PageHeader.svelte';
	import Section from '$lib/components/settings/Section.svelte';
	import SettingRow from '$lib/components/settings/SettingRow.svelte';

	let importing = $state(false);
	let importResult = $state<{ ok: boolean; message: string } | null>(null);
	let fileInput = $state<HTMLInputElement | undefined>(undefined);

	async function exportPrefs() {
		const res = await fetch('/api/preferences/export');
		if (!res.ok) return;
		const blob = await res.blob();
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = 'zajel-mail-preferences.json';
		document.body.appendChild(a);
		a.click();
		a.remove();
		URL.revokeObjectURL(url);
	}

	async function handleImportFile(e: Event) {
		const file = (e.target as HTMLInputElement).files?.[0];
		if (!file) return;
		importing = true;
		importResult = null;
		try {
			const text = await file.text();
			const payload = JSON.parse(text);
			const res = await fetch('/api/preferences/import', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(payload)
			});
			const data = await res.json().catch(() => ({}));
			if (res.ok) {
				importResult = { ok: true, message: `Imported ${data.imported ?? 0} preferences.` };
				await invalidateAll();
			} else {
				importResult = { ok: false, message: data.error ?? `HTTP ${res.status}` };
			}
		} catch (err) {
			importResult = { ok: false, message: err instanceof Error ? err.message : 'Invalid file' };
		} finally {
			importing = false;
			(e.target as HTMLInputElement).value = '';
		}
	}

	let resetting = $state(false);

	async function resetAll() {
		if (!confirm('Reset these settings to their defaults on every browser?')) return;
		resetting = true;
		try {
			await fetch('/api/preferences/reset', { method: 'POST' });
			await invalidateAll();
		} finally {
			resetting = false;
		}
	}
</script>

<svelte:head><title>{pageTitle({ page: 'Backup & reset', subtitle: 'Settings' })}</title></svelte:head>

<PageHeader title="Backup & reset" />

<Section title="Backup" id="export">
	<SettingRow title="Export settings">
		{#snippet control()}
			<button type="button" onclick={exportPrefs} class="btn btn-secondary btn-sm">Export</button>
		{/snippet}
	</SettingRow>
	<div id="import">
		<SettingRow
			title="Import settings"
			state={importResult && !importResult.ok ? 'error' : 'idle'}
			errorMessage={importResult?.message}
		>
			{#snippet control()}
				{#if importResult?.ok}
					<span class="text-[0.8125rem] text-text-tertiary">{importResult.message}</span>
				{/if}
				<input
					bind:this={fileInput}
					type="file"
					accept="application/json,.json"
					class="hidden"
					onchange={handleImportFile}
				/>
				<button type="button" onclick={() => fileInput?.click()} disabled={importing} class="btn btn-secondary btn-sm">
					{importing ? 'Importing…' : 'Choose file…'}
				</button>
			{/snippet}
		</SettingRow>
	</div>
</Section>

<!-- What a backup holds, and what it leaves out, matters before one is
     relied on: it stays, folded away. -->
<details class="-mt-4 mb-8 text-[0.8125rem] text-text-tertiary">
	<summary class="cursor-pointer font-semibold hover:text-text transition-colors select-none">
		What the file holds ({PREFERENCES.length} settings)
	</summary>
	<p class="mt-2 leading-relaxed max-w-prose">
		Not in it: your name and photo, linked accounts, sign-in and security, signatures, rules, folder
		and label colours, Jev, Assistant and search settings, Telegram and scheduled jobs. Importing
		sets what the file holds and leaves the rest as it is; Out of office on the mail server changes
		the next time you save it.
	</p>
	<ul class="mt-2 pl-3 space-y-1">
		{#each PREFERENCES as item (item.key)}
			<li>
				<code class="text-2xs bg-surface-hover rounded-md px-1 py-0.5">{item.key}</code>
				— {item.description}
			</li>
		{/each}
	</ul>
</details>

<Section title="Reset" id="reset">
	<SettingRow
		title="Reset settings"
		description="Everything a backup holds goes back to its default, on every browser. Mail, accounts, signatures and rules stay."
	>
		{#snippet control()}
			<button type="button" onclick={resetAll} disabled={resetting} class="btn btn-danger btn-sm">
				{resetting ? 'Resetting…' : 'Reset'}
			</button>
		{/snippet}
	</SettingRow>
</Section>
