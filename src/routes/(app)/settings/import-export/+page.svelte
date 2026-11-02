<script lang="ts">
	import { pageTitle } from '$lib/utils/title';
	import { invalidateAll } from '$app/navigation';
	import { PREFERENCES } from '$lib/preference-keys';

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

</script>

<svelte:head><title>{pageTitle({ page: 'Import / Export', subtitle: 'Settings' })}</title></svelte:head>

<header class="mb-6">
	<h1 class="text-xl font-semibold text-text">Import / Export</h1>
	<p class="text-sm text-text-tertiary mt-1 max-w-prose">
		Back up your settings, or copy them to another install.
	</p>
</header>

<section class="space-y-6">
	<div class="rounded-xl border border-border bg-surface-hover/40 p-4 flex items-start gap-4">
		<div class="flex-1">
			<p class="text-sm font-medium text-text">Export preferences</p>
			<p class="text-xs text-text-tertiary mt-1 leading-relaxed">
				A JSON file with the settings below. Not included: your name and photo, linked accounts,
				sign-in and security, signatures, rules, folder and label colours, Jev, Search and Agent
				settings, Telegram and scheduled jobs.
			</p>
			<details class="mt-3 text-xs text-text-tertiary">
				<summary class="cursor-pointer hover:text-text transition-colors select-none">
					Settings in the file ({PREFERENCES.length})
				</summary>
				<ul class="mt-2 pl-3 space-y-1">
					{#each PREFERENCES as item (item.key)}
						<li>
							<code class="text-2xs bg-surface-hover rounded-md px-1 py-0.5">{item.key}</code>
							— {item.description}
						</li>
					{/each}
				</ul>
			</details>
		</div>
		<button
			onclick={exportPrefs}
			class="btn btn-primary shrink-0"
		>
			Export
		</button>
	</div>

	<div class="rounded-xl border border-border bg-surface-hover/40 p-4 flex items-start gap-4">
		<div class="flex-1">
			<p class="text-sm font-medium text-text">Import preferences</p>
			<p class="text-xs text-text-tertiary mt-1">
				Sets the settings a file from Export holds and leaves the rest as they are. Auto-reply on
				the mail server changes the next time you save Settings → Auto-reply.
			</p>
			{#if importResult}
				<p class="text-xs mt-2 {importResult.ok ? 'text-accent-fg' : 'text-danger'}">{importResult.message}</p>
			{/if}
		</div>
		<input
			bind:this={fileInput}
			type="file"
			accept="application/json,.json"
			class="hidden"
			onchange={handleImportFile}
		/>
		<button
			onclick={() => fileInput?.click()}
			disabled={importing}
			class="btn btn-secondary shrink-0"
		>
			{importing ? 'Importing…' : 'Choose file…'}
		</button>
	</div>
</section>
