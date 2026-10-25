<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import type { CalendarInfo } from '$lib/calendar/types';
	import { apiImportEvents, type ImportBatchResult } from '$lib/calendar/api';
	import { readIcsFile, type IcsFile } from '$lib/calendar/import';

	const MAX_FILE_SIZE = 10 * 1024 * 1024;
	const MAX_EVENTS = 5_000;
	const PREVIEW_ROWS = 200;

	let {
		open,
		calendars,
		onClose,
		onImported
	}: {
		open: boolean;
		calendars: CalendarInfo[];
		onClose: () => void;
		onImported: (result: ImportBatchResult) => void;
	} = $props();

	let calendarId = $state('');
	let file = $state<IcsFile | null>(null);
	let error = $state('');
	let reading = $state(false);
	let importing = $state(false);
	let done = $state(0);
	let result = $state<ImportBatchResult | null>(null);
	let previousOpen = false;

	const eventCount = $derived(file?.events.length ?? 0);
	const dateFormat = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });

	$effect(() => {
		if (open && !previousOpen) {
			calendarId = calendars.find((c) => c.isDefault)?.id ?? calendars[0]?.id ?? '';
			file = null;
			error = '';
			reading = false;
			importing = false;
			done = 0;
			result = null;
		}
		previousOpen = open;
	});

	async function chooseFile(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const picked = input.files?.[0];
		if (!picked) return;
		error = '';
		file = null;
		result = null;
		if (picked.size > MAX_FILE_SIZE) {
			error = 'Choose a calendar file smaller than 10 MB.';
			input.value = '';
			return;
		}
		reading = true;
		try {
			const parsed = readIcsFile(await picked.text());
			if (parsed.events.length === 0) throw new Error('No events in this file.');
			if (parsed.events.length > MAX_EVENTS) {
				throw new Error(`This file has more than ${MAX_EVENTS.toLocaleString()} events.`);
			}
			file = parsed;
		} catch (caught) {
			error = (caught as Error).message || 'The selected file could not be read.';
			input.value = '';
		} finally {
			reading = false;
		}
	}

	async function runImport() {
		if (!file || importing || !calendarId) return;
		importing = true;
		error = '';
		done = 0;
		const total: ImportBatchResult = { imported: 0, failed: 0, firstDay: null };
		try {
			for (const batch of file.batches) {
				try {
					const res = await apiImportEvents(calendarId, batch.ics);
					total.imported += res.imported;
					total.failed += res.failed;
					if (res.firstDay && (!total.firstDay || res.firstDay < total.firstDay)) total.firstDay = res.firstDay;
				} catch (caught) {
					// A batch the server refused outright counts as failed;
					// the rest still go up.
					total.failed += batch.count;
					error = (caught as Error).message;
				}
				done += batch.count;
			}
		} finally {
			importing = false;
			result = total;
			if (total.imported > 0) onImported(total);
		}
	}

	function cancel() {
		if (!importing) onClose();
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault();
			cancel();
		}
	}
</script>

{#if open}
	<div
		class="fixed inset-0 z-[75] bg-black/60 backdrop-blur-[2px] flex items-center justify-center p-3 md:p-6"
		role="dialog"
		aria-modal="true"
		aria-labelledby="import-events-title"
		tabindex="-1"
		onkeydown={handleKeydown}
	>
		<div class="w-full max-w-xl max-h-full rounded-xl bg-surface border border-border shadow-2xl flex flex-col">
			<header class="h-14 shrink-0 px-5 border-b border-border flex items-center justify-between">
				<h2 id="import-events-title" class="text-lg font-semibold text-text">Import events</h2>
				<button type="button" aria-label="Close" class="p-2 rounded-lg text-text-tertiary hover:text-text hover:bg-surface-hover cursor-pointer" onclick={cancel}><Icon name="close" /></button>
			</header>

			<div class="flex-1 min-h-0 overflow-y-auto p-5 space-y-5">
				<div class="grid sm:grid-cols-2 gap-4">
					<label class="block">
						<span class="block text-sm font-medium text-text mb-1.5">Calendar file</span>
						<input
							type="file"
							accept=".ics,.ical,.ifb,.icalendar,text/calendar"
							disabled={reading || importing}
							onchange={chooseFile}
							class="block w-full text-sm text-text-secondary file:mr-3 file:px-3 file:py-2 file:rounded-lg file:border-0 file:bg-surface-hover file:text-text file:cursor-pointer"
						/>
					</label>
					<label class="block">
						<span class="block text-sm font-medium text-text mb-1.5">Import into</span>
						<select bind:value={calendarId} disabled={importing || calendars.length === 0} class="w-full h-10 px-3 rounded-lg bg-surface-hover border border-border text-sm text-text outline-none">
							{#each calendars as cal (cal.id)}
								<option value={cal.id}>{cal.name}</option>
							{/each}
						</select>
					</label>
				</div>

				{#if reading}
					<div class="text-sm text-text-secondary" role="status">Reading file…</div>
				{/if}
				{#if error}
					<div class="p-3 rounded-lg bg-danger/10 text-danger text-sm" role="alert">{error}</div>
				{/if}

				{#if file && !result}
					<div class="border border-border rounded-lg overflow-hidden">
						<div class="max-h-72 overflow-y-auto divide-y divide-border">
							{#each file.events.slice(0, PREVIEW_ROWS) as ev (ev.key)}
								<div class="px-3 py-2 flex items-baseline gap-3">
									<span class="flex-1 min-w-0 text-sm text-text truncate">{ev.title || '(untitled event)'}</span>
									{#if ev.start}
										<span class="shrink-0 text-xs text-text-tertiary tabular-nums">{dateFormat.format(ev.start)}</span>
									{/if}
								</div>
							{/each}
						</div>
						{#if eventCount > PREVIEW_ROWS}
							<div class="px-3 py-2 border-t border-border text-xs text-text-tertiary">{PREVIEW_ROWS} of {eventCount.toLocaleString()}</div>
						{/if}
					</div>
				{/if}

				{#if result}
					<div class="p-4 rounded-lg bg-success/10 border border-success/20" role="status" aria-live="polite">
						<p class="text-sm font-medium text-success">Imported {result.imported.toLocaleString()} {result.imported === 1 ? 'event' : 'events'}</p>
						{#if result.failed > 0}
							<p class="text-xs text-text-secondary mt-1">{result.failed.toLocaleString()} {result.failed === 1 ? 'event' : 'events'} couldn’t be imported.</p>
						{/if}
					</div>
				{/if}
			</div>

			<footer class="shrink-0 px-5 py-4 border-t border-border flex justify-end gap-2">
				<button type="button" disabled={importing} class="btn btn-ghost btn-lg" onclick={cancel}>{result ? 'Done' : 'Cancel'}</button>
				{#if !result}
					<button
						type="button"
						disabled={importing || !file || !calendarId}
						class="btn btn-primary btn-lg"
						onclick={runImport}
					>
						{#if importing}
							Importing {done.toLocaleString()} / {eventCount.toLocaleString()}
						{:else}
							Import {eventCount > 0 ? eventCount.toLocaleString() : ''}
						{/if}
					</button>
				{/if}
			</footer>
		</div>
	</div>
{/if}
