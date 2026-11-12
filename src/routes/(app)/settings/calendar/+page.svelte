<script lang="ts">
	import { untrack } from 'svelte';
	import { pageTitle } from '$lib/utils/title';
	import { invalidateAll } from '$app/navigation';
	import PageHeader from '$lib/components/settings/PageHeader.svelte';
	import Section from '$lib/components/settings/Section.svelte';
	import SettingRow from '$lib/components/settings/SettingRow.svelte';
	import Select from '$lib/components/settings/Select.svelte';
	import { useDraft } from '$lib/settings/draft.svelte';
	import { sendJson } from '$lib/settings/send';
	import type { LayoutData } from '../$types';

	let { data }: { data: LayoutData } = $props();

	// Stored when Save is pressed in the pill at the foot of the page.
	const draft = useDraft({
		// What the page opened with; later reloads of `data` leave the form alone.
		initial: untrack(() => ({ weekStart: String(data.calendarWeekStart) })),
		async persist(_changed, all) {
			await sendJson('/api/preferences/calendar', { weekStart: Number(all.weekStart) });
			await invalidateAll();
		}
	});
</script>

<svelte:head><title>{pageTitle({ page: 'Calendar', subtitle: 'Settings' })}</title></svelte:head>

<PageHeader title="Calendar" />

<Section>
	<SettingRow title="Week starts on">
		{#snippet control()}
			<Select
				value={draft.value.weekStart}
				ariaLabel="Week starts on"
				options={[
					{ value: '6', label: 'Saturday' },
					{ value: '0', label: 'Sunday' },
					{ value: '1', label: 'Monday' }
				]}
				onchange={(next) => (draft.value.weekStart = next)}
			/>
		{/snippet}
	</SettingRow>
</Section>
