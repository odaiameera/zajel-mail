<script lang="ts">
	import { untrack } from 'svelte';
	import { pageTitle } from '$lib/utils/title';
	import { invalidateAll } from '$app/navigation';
	import PageHeader from '$lib/components/settings/PageHeader.svelte';
	import Section from '$lib/components/settings/Section.svelte';
	import Segmented from '$lib/components/settings/Segmented.svelte';
	import SettingRow from '$lib/components/settings/SettingRow.svelte';
	import Toggle from '$lib/components/settings/Toggle.svelte';
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

	// Stored when Save is pressed in the pill at the foot of the page.
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

	// The themes, each drawn as a small picture of the app in its colours
	// (the chrome, the content panel on it, lines of text).
	const THEMES = [
		{ value: 'light', label: 'Light', chrome: '#eef1f4', panel: '#ffffff', line: '#d1d9e0' },
		{ value: 'dark', label: 'Dark', chrome: '#010409', panel: '#161b22', line: '#3d444d' }
	];

	function pickTheme(next: string) {
		draft.value.theme = next;
		preview(draft.value);
	}

	// A radio group: the arrow keys move between the two.
	function onThemeKeydown(e: KeyboardEvent) {
		if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
		e.preventDefault();
		const next = THEMES.find((t) => t.value !== draft.value.theme) ?? THEMES[0];
		pickTheme(next.value);
		(e.currentTarget as HTMLElement).querySelector<HTMLElement>(`[data-theme="${next.value}"]`)?.focus();
	}
</script>

<svelte:head><title>{pageTitle({ page: 'Appearance', subtitle: 'Settings' })}</title></svelte:head>

<PageHeader title="Appearance" />

<Section title="Theme" bare>
	<div
		role="radiogroup"
		aria-label="Theme"
		tabindex="-1"
		onkeydown={onThemeKeydown}
		class="grid grid-cols-[repeat(auto-fill,minmax(min(11rem,100%),1fr))] gap-4 pt-1"
	>
		{#each THEMES as theme (theme.value)}
			{@const on = draft.value.theme === theme.value}
			<button
				type="button"
				role="radio"
				aria-checked={on}
				tabindex={on ? 0 : -1}
				data-theme={theme.value}
				onclick={() => pickTheme(theme.value)}
				class="group flex flex-col gap-2 text-left cursor-pointer rounded-[10px]"
			>
				<span
					class="flex h-24 rounded-[10px] overflow-hidden border border-border pt-3 pl-3 transition-shadow
						{on ? 'ring-2 ring-accent ring-offset-2 ring-offset-bg' : 'group-hover:border-text-tertiary'}"
					style="background-color: {theme.chrome}"
					aria-hidden="true"
				>
					<span class="flex-1 flex flex-col gap-[7px] p-3 rounded-tl-md" style="background-color: {theme.panel}">
						<span class="w-[55%] h-[5px] rounded-full" style="background-color: {theme.line}"></span>
						<span class="w-[85%] h-[5px] rounded-full" style="background-color: {theme.line}"></span>
						<span class="w-[40%] h-[5px] rounded-full" style="background-color: {theme.line}"></span>
					</span>
				</span>
				<span class="text-[0.8125rem] {on ? 'font-semibold text-text' : 'font-medium text-text-secondary'}">{theme.label}</span>
			</button>
		{/each}
	</div>
</Section>

<Section title="Layout">
	<SettingRow title="Density">
		{#snippet control()}
			<Segmented
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

	<SettingRow title="Reading pane">
		{#snippet control()}
			<Toggle
				checked={draft.value.readingPane}
				ariaLabel="Reading pane"
				onChange={(next) => (draft.value.readingPane = next)}
			/>
		{/snippet}
	</SettingRow>
</Section>
