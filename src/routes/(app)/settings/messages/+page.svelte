<script lang="ts">
	import { untrack } from 'svelte';
	import { pageTitle } from '$lib/utils/title';
	import { invalidateAll } from '$app/navigation';
	import PageHeader from '$lib/components/settings/PageHeader.svelte';
	import Section from '$lib/components/settings/Section.svelte';
	import LinkRow from '$lib/components/settings/LinkRow.svelte';
	import SettingRow from '$lib/components/settings/SettingRow.svelte';
	import Toggle from '$lib/components/settings/Toggle.svelte';
	import Select from '$lib/components/settings/Select.svelte';
	import NumberInput from '$lib/components/settings/NumberInput.svelte';
	import { userState, updateSettings } from '$lib/stores/userState';
	import { useDraft } from '$lib/settings/draft.svelte';
	import { saveEach, sendJson, type SaveStep } from '$lib/settings/send';
	import { MAX_MARK_READ_DELAY } from '$lib/mail-prefs';
	import ComposerSection from './ComposerSection.svelte';
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
		defaultSort: 'Sort',
		markReadSeconds: 'Mark as read after',
		autoLoadImages: 'Remote images',
		trashRetentionDays: 'Empty Trash',
		otpTrashAfterCopy: 'Trash sign-in codes after copying',
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
		// Only a value typed here is held to the limits, as for the composer below.
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

<svelte:head><title>{pageTitle({ page: 'Messages & composer', subtitle: 'Settings' })}</title></svelte:head>

<PageHeader title="Messages & composer" />

<Section title="Inbox" id="inbox">
	<SettingRow title="Sort">
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

	<SettingRow title="Messages per page">
		{#snippet control()}
			<Select
				value={draft.value.pageSize}
				ariaLabel="Messages per page"
				onchange={(v) => (draft.value.pageSize = v)}
				options={PAGE_SIZES.map((n) => ({ value: String(n), label: String(n) }))}
			/>
		{/snippet}
	</SettingRow>
</Section>

<Section title="Opening mail" id="opening-mail">
	<SettingRow title="Mark as read after">
		{#snippet control()}
			<NumberInput
				bind:value={draft.value.markReadSeconds}
				min={0}
				max={MAX_MARK_READ_SECONDS}
				step={0.1}
				ariaLabel="Mark as read after (seconds)"
				width="80px"
			/>
			<span class="text-sm text-text-tertiary">seconds</span>
		{/snippet}
	</SettingRow>

	<SettingRow title="Remote images">
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
</Section>

<Section title="Trash" id="trash">
	<SettingRow title="Empty Trash">
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

	<SettingRow title="Trash sign-in codes after copying">
		{#snippet control()}
			<Toggle
				checked={draft.value.otpTrashAfterCopy}
				ariaLabel="Trash sign-in codes after copying"
				onChange={(v) => (draft.value.otpTrashAfterCopy = v)}
			/>
		{/snippet}
	</SettingRow>
</Section>

<ComposerSection {data} />

<!-- Each opens a page of its own, under this one. -->
<Section title="More" id="more">
	<LinkRow
		title="Signatures"
		href="/settings/messages/signatures"
		value={$userState.loaded ? ($userState.signatures?.length ?? 0) : undefined}
	/>
	<LinkRow title="Out of office" href="/settings/messages/out-of-office" value={data.autoReplyEnabled ? 'On' : 'Off'} />
</Section>
