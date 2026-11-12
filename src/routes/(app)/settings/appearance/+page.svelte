<script lang="ts">
	import { untrack } from 'svelte';
	import { pageTitle } from '$lib/utils/title';
	import { invalidateAll } from '$app/navigation';
	import SettingRow from '$lib/components/settings/SettingRow.svelte';
	import Toggle from '$lib/components/settings/Toggle.svelte';
	import Select from '$lib/components/settings/Select.svelte';
	import { useDraft } from '$lib/settings/draft.svelte';
	import { saveEach, sendJson, type SaveStep } from '$lib/settings/send';
	import type { LayoutData } from '../$types';

	let { data }: { data: LayoutData } = $props();

	type Look = { theme: string; density: string; readingPane: boolean };

	/**
	 * Shows a theme and density on the page without storing them, so a
	 * choice can be seen before Save is pressed. Discard, and leaving without
	 * saving, call this with the saved values to take it back.
	 */
	function preview(look: Look) {
		if (typeof document === 'undefined') return;
		document.documentElement.classList.toggle('light', look.theme === 'light');
		// Keep the PWA/mobile browser bar on --color-surface for the theme.
		document
			.querySelector('meta[name=theme-color]')
			?.setAttribute('content', look.theme === 'light' ? '#f6f8fa' : '#010409');
		// Density is a class on the app shell that tightens the message rows.
		document.querySelector('.app-shell')?.classList.toggle('density-compact', look.density === 'compact');
	}

	// Stored when Save is pressed in the bar at the foot of the page.
	const draft = useDraft<Look>({
		// What the page opened with; later reloads of `data` leave the form alone.
		initial: untrack(() => ({ theme: data.theme, density: data.density, readingPane: data.readingPane === 'on' })),
		preview,
		async persist(changed, _all, stored) {
			// Each has its own endpoint; only the ones that changed are sent.
			const steps: SaveStep<Look>[] = [];
			if (changed.theme !== undefined) {
				const value = changed.theme;
				steps.push({ label: 'Theme', values: { theme: value }, run: () => sendJson('/api/preferences/theme', { value }) });
			}
			if (changed.density !== undefined) {
				const value = changed.density;
				steps.push({ label: 'Density', values: { density: value }, run: () => sendJson('/api/preferences/density', { value }) });
			}
			if (changed.readingPane !== undefined) {
				const on = changed.readingPane;
				steps.push({
					label: 'Reading pane',
					values: { readingPane: on },
					run: () => sendJson('/api/preferences/reading-pane', { value: on ? 'on' : 'off' })
				});
			}
			try {
				await saveEach(stored, steps);
			} finally {
				await invalidateAll();
			}
		}
	});
</script>

<svelte:head><title>{pageTitle({ page: 'Appearance', subtitle: 'Settings' })}</title></svelte:head>

<header class="mb-6">
	<h1 class="text-xl font-semibold text-text">Appearance</h1>
	<p class="text-sm text-text-tertiary mt-1">How Zajel Mail looks and feels.</p>
</header>

<section>
	<SettingRow title="Theme" description="Dark or light interface.">
		{#snippet control()}
			<Select
				value={draft.value.theme}
				ariaLabel="Theme"
				onchange={(next) => {
					draft.value.theme = next;
					preview(draft.value);
				}}
				options={[
					{ value: 'dark', label: 'Dark' },
					{ value: 'light', label: 'Light' }
				]}
			/>
		{/snippet}
	</SettingRow>

	<SettingRow
		title="Density"
		description="Compact shows more messages per screen; comfortable has more breathing room."
	>
		{#snippet control()}
			<Select
				value={draft.value.density}
				ariaLabel="Density"
				onchange={(next) => {
					draft.value.density = next;
					preview(draft.value);
				}}
				options={[
					{ value: 'comfortable', label: 'Comfortable' },
					{ value: 'compact', label: 'Compact' }
				]}
			/>
		{/snippet}
	</SettingRow>

	<SettingRow
		title="Reading pane"
		description="Show a preview pane to the right of the email list on wide screens."
	>
		{#snippet control()}
			<Toggle
				checked={draft.value.readingPane}
				ariaLabel="Reading pane"
				onChange={(next) => (draft.value.readingPane = next)}
			/>
		{/snippet}
	</SettingRow>
</section>
