<script lang="ts">
	import { pageTitle } from '$lib/utils/title';
	import { invalidateAll } from '$app/navigation';
	import SettingRow, { type SaveState } from '$lib/components/settings/SettingRow.svelte';
	import Toggle from '$lib/components/settings/Toggle.svelte';
	import Select from '$lib/components/settings/Select.svelte';
	import { userState, updateSettings } from '$lib/stores/userState';
	import type { LayoutData } from '../$types';

	let { data }: { data: LayoutData } = $props();

	let markReadDelay = $state(String(data.markReadDelay));
	let autoLoadImages = $state(data.autoLoadImages);
	let defaultSort = $state<string>(data.defaultSort);
	let trashRetentionDays = $state(String(data.trashRetentionDays));
	let otpTrashAfterCopy = $state(data.otpTrashAfterCopy);

	// Stored as a string like every preference, so parse rather than type-check,
	// or the select would show 50 after every reload.
	const PAGE_SIZES = [10, 25, 50, 100];
	const defaultPageSize = $derived.by(() => {
		const n = Number($userState.settings.defaultPageSize);
		return PAGE_SIZES.includes(n) ? n : 50;
	});
	let pageSizeState = $state<SaveState>('idle');

	async function savePageSize(v: string) {
		pageSizeState = 'saving';
		try {
			await updateSettings({ settings: { defaultPageSize: parseInt(v) } });
			pageSizeState = 'saved';
			setTimeout(() => { if (pageSizeState === 'saved') pageSizeState = 'idle'; }, 1800);
		} catch {
			pageSizeState = 'error';
		}
	}

	const states = $state<Record<string, SaveState>>({});
	function flash(key: string, ok: boolean) {
		states[key] = ok ? 'saved' : 'error';
		if (ok) setTimeout(() => { if (states[key] === 'saved') states[key] = 'idle'; }, 1800);
	}

	async function save(patch: Record<string, unknown>, key: string) {
		states[key] = 'saving';
		try {
			const res = await fetch('/api/preferences/mail', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(patch)
			});
			flash(key, res.ok);
			if (res.ok) await invalidateAll();
		} catch {
			flash(key, false);
		}
	}
</script>

<svelte:head><title>{pageTitle({ page: 'Messages', subtitle: 'Settings' })}</title></svelte:head>

<header class="mb-6">
	<h1 class="text-xl font-semibold text-text">Messages</h1>
	<p class="text-sm text-text-tertiary mt-1">How messages are displayed and treated.</p>
</header>

<section>
	<SettingRow
		title="Default sort"
		description="Order of the Inbox, folders and Starred."
		state={states.defaultSort ?? 'idle'}
	>
		{#snippet control()}
			<Select
				value={defaultSort}
				ariaLabel="Default sort"
				onchange={(v) => { defaultSort = v; save({ defaultSort: v }, 'defaultSort'); }}
				options={[
					{ value: 'date_desc', label: 'Newest first' },
					{ value: 'date_asc', label: 'Oldest first' },
					{ value: 'subject', label: 'Subject (A–Z)' },
					{ value: 'from', label: 'Sender (A–Z)' }
				]}
			/>
		{/snippet}
	</SettingRow>

	<SettingRow
		title="Mark as read after"
		description="Time (ms) to wait before marking an open email as read. 0 = instantly."
		state={states.markReadDelay ?? 'idle'}
	>
		{#snippet control()}
			<input
				type="number"
				bind:value={markReadDelay}
				min={0}
				max={10000}
				step={100}
				onblur={() => save({ markReadDelay: parseInt(markReadDelay) || 0 }, 'markReadDelay')}
				class="bg-surface-hover border border-border rounded-lg px-2.5 py-1.5 text-sm text-text outline-none focus:border-accent w-[110px]"
				aria-label="Mark as read delay (ms)"
			/>
		{/snippet}
	</SettingRow>

	<SettingRow
		title="Auto-load remote images"
		description="Remote images can track whether you opened the message. Choose your comfort level."
		state={states.autoLoadImages ?? 'idle'}
	>
		{#snippet control()}
			<Select
				value={autoLoadImages}
				ariaLabel="Auto-load remote images"
				onchange={(v) => { autoLoadImages = v; save({ autoLoadImages: v }, 'autoLoadImages'); }}
				options={[
					{ value: 'never', label: 'Never' },
					{ value: 'contacts_only', label: 'Contacts only' },
					{ value: 'always', label: 'Always' }
				]}
			/>
		{/snippet}
	</SettingRow>

	<SettingRow
		title="Empty Trash automatically"
		description="Permanently delete messages once they have been in Trash this long, in every linked account. Messages already in Trash when you turn this on get the full period."
		state={states.trashRetentionDays ?? 'idle'}
	>
		{#snippet control()}
			<Select
				value={trashRetentionDays}
				ariaLabel="Empty Trash automatically"
				onchange={(v) => { trashRetentionDays = v; save({ trashRetentionDays: parseInt(v, 10) }, 'trashRetentionDays'); }}
				options={[
					{ value: '0', label: 'Never' },
					{ value: '7', label: 'After 7 days' },
					{ value: '30', label: 'After 30 days' }
				]}
			/>
		{/snippet}
	</SettingRow>

	<SettingRow
		title="Trash sign-in code emails after copying"
		description="When an email contains a verification code, a Copy button appears above it. With this on, copying the code also moves the email to Trash."
		state={states.otpTrashAfterCopy ?? 'idle'}
	>
		{#snippet control()}
			<Toggle
				checked={otpTrashAfterCopy}
				onChange={(v) => { otpTrashAfterCopy = v; save({ otpTrashAfterCopy: v }, 'otpTrashAfterCopy'); }}
			/>
		{/snippet}
	</SettingRow>

	<SettingRow
		title="Messages per page"
		description="How many messages to show per page in the inbox, folders, and search. Follows you across browsers."
		state={pageSizeState}
	>
		{#snippet control()}
			<Select
				value={String(defaultPageSize)}
				ariaLabel="Messages per page"
				onchange={savePageSize}
				options={[
					{ value: '10', label: '10 per page' },
					{ value: '25', label: '25 per page' },
					{ value: '50', label: '50 per page' },
					{ value: '100', label: '100 per page' }
				]}
			/>
		{/snippet}
	</SettingRow>
</section>
