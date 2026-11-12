<script lang="ts">
	import { untrack } from 'svelte';
	import { pageTitle } from '$lib/utils/title';
	import { invalidateAll } from '$app/navigation';
	import SettingRow from '$lib/components/settings/SettingRow.svelte';
	import Toggle from '$lib/components/settings/Toggle.svelte';
	import Select from '$lib/components/settings/Select.svelte';
	import NumberInput from '$lib/components/settings/NumberInput.svelte';
	import { userState, updateSettings } from '$lib/stores/userState';
	import { useDraft } from '$lib/settings/draft.svelte';
	import { saveEach, sendJson, type SaveStep } from '$lib/settings/send';
	import { MAX_MARK_READ_DELAY } from '$lib/mail-prefs';
	import type { LayoutData } from '../$types';

	let { data }: { data: LayoutData } = $props();

	// Stored as a string like every preference, so parse rather than type-check,
	// or the select would show 50 after every reload.
	const PAGE_SIZES = [10, 25, 50, 100];
	function storedPageSize(settings: Record<string, unknown>): string {
		const n = Number(settings.defaultPageSize);
		return String(PAGE_SIZES.includes(n) ? n : 50);
	}

	// "Mark as read after" is stored and sent in milliseconds; people think
	// in seconds, so that is what the field shows. Converted here and nowhere
	// else.
	const MAX_MARK_READ_SECONDS = MAX_MARK_READ_DELAY / 1000;

	type Values = {
		defaultSort: string;
		markReadSeconds: number | null;
		autoLoadImages: string;
		trashRetentionDays: string;
		otpTrashAfterCopy: boolean;
		pageSize: string;
	};

	// The rows' titles, to say which of them didn't save.
	const TITLES: Record<keyof Values, string> = {
		defaultSort: 'Default sort',
		markReadSeconds: 'Mark as read after',
		autoLoadImages: 'Auto-load remote images',
		trashRetentionDays: 'Empty Trash automatically',
		otpTrashAfterCopy: 'Trash sign-in code emails after copying',
		pageSize: 'Messages per page'
	};

	// Stored when Save is pressed in the bar at the foot of the page.
	const draft = useDraft<Values>({
		// What the page opened with; later reloads of `data` leave the form alone.
		initial: untrack(() => ({
			defaultSort: data.defaultSort,
			markReadSeconds: data.markReadDelay / 1000,
			autoLoadImages: data.autoLoadImages,
			trashRetentionDays: String(data.trashRetentionDays),
			otpTrashAfterCopy: data.otpTrashAfterCopy,
			pageSize: storedPageSize($userState.settings)
		})),
		// Only a value typed here is held to the limits, as on Composer.
		check: ({ markReadSeconds: s }, changed) =>
			changed('markReadSeconds') && (s === null || s < 0 || s > MAX_MARK_READ_SECONDS)
				? `“Mark as read after” takes 0 to ${MAX_MARK_READ_SECONDS} seconds.`
				: '',
		async persist(changed, _all, stored) {
			const mail: Record<string, unknown> = {};
			const mailValues: Partial<Values> = {};
			// The field takes tenths of a second; anything finer is rounded to that.
			if (changed.markReadSeconds !== undefined) {
				const seconds = Math.round((changed.markReadSeconds ?? 0) * 10) / 10;
				mail.markReadDelay = Math.round(seconds * 1000);
				mailValues.markReadSeconds = seconds;
			}
			for (const key of ['defaultSort', 'autoLoadImages', 'otpTrashAfterCopy'] as const) {
				if (changed[key] === undefined) continue;
				mail[key] = changed[key];
				(mailValues as Record<string, unknown>)[key] = changed[key];
			}
			if (changed.trashRetentionDays !== undefined) {
				mail.trashRetentionDays = parseInt(changed.trashRetentionDays, 10);
				mailValues.trashRetentionDays = changed.trashRetentionDays;
			}

			const steps: SaveStep<Values>[] = [];
			if (Object.keys(mail).length > 0) {
				const label = Object.keys(mailValues)
					.map((key) => TITLES[key as keyof Values])
					.join(', ');
				steps.push({ label, values: mailValues, run: () => sendJson('/api/preferences/mail', mail) });
			}
			// The page size lives with the other per-login values in the user
			// store, which has its own endpoint.
			if (changed.pageSize !== undefined) {
				const pageSize = changed.pageSize;
				steps.push({
					label: TITLES.pageSize,
					values: { pageSize },
					run: () => updateSettings({ settings: { defaultPageSize: parseInt(pageSize, 10) } })
				});
			}
			try {
				await saveEach(stored, steps);
			} finally {
				if (Object.keys(mail).length > 0) await invalidateAll();
			}
		}
	});

	// Opened straight on this address, the page is here before the user store
	// has loaded, so the page size isn't known yet. Take it once, when the
	// store arrives; after that the store changing never touches the form.
	let pageSizeKnown = $userState.loaded;
	$effect(() => {
		if (pageSizeKnown || !$userState.loaded) return;
		pageSizeKnown = true;
		draft.seed({ pageSize: storedPageSize($userState.settings) });
	});
</script>

<svelte:head><title>{pageTitle({ page: 'Messages', subtitle: 'Settings' })}</title></svelte:head>

<header class="mb-6">
	<h1 class="text-xl font-semibold text-text">Messages</h1>
	<p class="text-sm text-text-tertiary mt-1">How messages are displayed and treated.</p>
</header>

<section>
	<SettingRow title="Default sort" description="Order of the Inbox, folders and Starred.">
		{#snippet control()}
			<Select
				value={draft.value.defaultSort}
				ariaLabel="Default sort"
				onchange={(v) => (draft.value.defaultSort = v)}
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
		description="Seconds to wait before marking an open email as read. 0 = instantly."
	>
		{#snippet control()}
			<NumberInput
				bind:value={draft.value.markReadSeconds}
				min={0}
				max={MAX_MARK_READ_SECONDS}
				step={0.1}
				ariaLabel="Mark as read after (seconds)"
			/>
		{/snippet}
	</SettingRow>

	<SettingRow
		title="Auto-load remote images"
		description="Remote images can track whether you opened the message. Choose your comfort level."
	>
		{#snippet control()}
			<Select
				value={draft.value.autoLoadImages}
				ariaLabel="Auto-load remote images"
				onchange={(v) => (draft.value.autoLoadImages = v)}
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
	>
		{#snippet control()}
			<Select
				value={draft.value.trashRetentionDays}
				ariaLabel="Empty Trash automatically"
				onchange={(v) => (draft.value.trashRetentionDays = v)}
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
	>
		{#snippet control()}
			<Toggle
				checked={draft.value.otpTrashAfterCopy}
				ariaLabel="Trash sign-in code emails after copying"
				onChange={(v) => (draft.value.otpTrashAfterCopy = v)}
			/>
		{/snippet}
	</SettingRow>

	<SettingRow
		title="Messages per page"
		description="How many messages to show per page in the inbox, folders, and search. Follows you across browsers."
	>
		{#snippet control()}
			<Select
				value={draft.value.pageSize}
				ariaLabel="Messages per page"
				onchange={(v) => (draft.value.pageSize = v)}
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
