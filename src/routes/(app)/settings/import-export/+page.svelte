<script lang="ts">
	import { pageTitle } from '$lib/utils/title';
	import { invalidateAll } from '$app/navigation';

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

	// Mirrors PREF_KEYS in src/lib/server/preferences.ts (a server module, so
	// the list is repeated here rather than imported). Rules, signatures and
	// label colours live in their own tables and are not part of the export.
	const exportedKeys: Array<{ key: string; description: string }> = [
		{ key: 'theme',                 description: 'Light / dark theme' },
		{ key: 'density',               description: 'Comfortable / compact row density' },
		{ key: 'reading_pane',          description: 'Reading pane on / off' },
		{ key: 'composer_font',         description: 'Default composer font' },
		{ key: 'composer_font_size',    description: 'Default composer font size' },
		{ key: 'autosave_interval',     description: 'Draft auto-save interval, seconds' },
		{ key: 'undo_send_seconds',     description: 'Undo send delay, seconds' },
		{ key: 'mark_read_delay',       description: 'Mark-as-read delay, milliseconds' },
		{ key: 'auto_load_images',      description: 'Remote-image policy' },
		{ key: 'default_sort',          description: 'Default inbox sort' },
		{ key: 'trash_retention_days',  description: 'Days before Trash is emptied (0 = never)' },
		{ key: 'otp_trash_after_copy',  description: 'Trash sign-in code emails after copying' },
		{ key: 'notifications',         description: 'Browser notifications on / off' },
		{ key: 'notification_folders',  description: 'Folders that fire notifications' },
		{ key: 'notify_calendar_events', description: 'Notify for new and changed events' },
		{ key: 'notify_event_reminders', description: 'Fire event reminders' },
		{ key: 'calendar_week_start',   description: 'First day of the calendar week' },
		{ key: 'calendar_view',         description: 'Last calendar view' },
		{ key: 'auto_reply_enabled',    description: 'Vacation auto-reply on / off' },
		{ key: 'auto_reply_subject',    description: 'Vacation auto-reply subject' },
		{ key: 'auto_reply_body',       description: 'Vacation auto-reply body' },
		{ key: 'folder_expanded',       description: 'Sidebar folder expand / collapse state' },
		{ key: 'defaultPageSize',       description: 'Messages per page' }
	];
</script>

<svelte:head><title>{pageTitle({ page: 'Import / Export', subtitle: 'Settings' })}</title></svelte:head>

<header class="mb-6">
	<h1 class="text-xl font-semibold text-text">Import / Export</h1>
	<p class="text-sm text-text-tertiary mt-1 max-w-prose">
		Back up the preferences stored for your login, or restore them on another install.
	</p>
</header>

<section class="space-y-6">
	<div class="rounded-xl border border-border bg-surface-hover/40 p-4 flex items-start gap-4">
		<div class="flex-1">
			<p class="text-sm font-medium text-text">Export preferences</p>
			<p class="text-xs text-text-tertiary mt-1 leading-relaxed">
				Downloads a JSON file with your preferences — theme, density, reading-pane state, composer
				font and size, mail display options, messages per page, notification toggles, calendar
				settings, auto-reply text, and folder-expand state.
				<br /><br />
				Rules, signatures, label and folder colours, linked accounts and your sign-in are stored
				separately and are <strong>not</strong> part of this export.
			</p>
			<details class="mt-3 text-xs text-text-tertiary">
				<summary class="cursor-pointer hover:text-text transition-colors select-none">
					Show every key included in the export ({exportedKeys.length})
				</summary>
				<ul class="mt-2 pl-3 space-y-1">
					{#each exportedKeys as item (item.key)}
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
				Load a JSON file from a previous export. Only known preference keys are accepted — unknown
				or mis-typed fields are ignored so a bad file can't break anything.
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
