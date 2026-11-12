<script lang="ts">
	import { untrack } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import Section from '$lib/components/settings/Section.svelte';
	import SettingRow from '$lib/components/settings/SettingRow.svelte';
	import Select from '$lib/components/settings/Select.svelte';
	import NumberInput from '$lib/components/settings/NumberInput.svelte';
	import { useDraft } from '$lib/settings/draft.svelte';
	import { sendJson } from '$lib/settings/send';
	import type { LayoutData } from '../$types';

	/**
	 * The composer's defaults, a section of Messages & composer. It keeps its
	 * own draft; the page's one Save pill stores it with the rest.
	 */
	let { data }: { data: LayoutData } = $props();

	// The server's own limits for how often an open draft saves itself. It
	// would quietly clamp a number outside them; saying so is kinder.
	const AUTO_SAVE_MIN = 5;
	const AUTO_SAVE_MAX = 120;

	type Values = {
		undoSendSeconds: string;
		font: string;
		fontSize: string;
		autoSaveInterval: number | null;
	};

	// Stored when Save is pressed in the pill at the foot of the page.
	const draft = useDraft<Values>({
		// What the page opened with; later reloads of `data` leave the form alone.
		initial: untrack(() => ({
			undoSendSeconds: String(data.undoSendSeconds),
			font: data.composerFont,
			fontSize: data.composerFontSize,
			autoSaveInterval: data.autoSaveInterval
		})),
		// Only a value typed here is held to the limits: one stored before them
		// (or brought in by Import) doesn't stop the rest of the page saving.
		check: ({ autoSaveInterval: n }, changed) =>
			changed('autoSaveInterval') && (n === null || n < AUTO_SAVE_MIN || n > AUTO_SAVE_MAX)
				? `“Save drafts every” takes ${AUTO_SAVE_MIN} to ${AUTO_SAVE_MAX} seconds.`
				: '',
		async persist(changed) {
			const body: Record<string, unknown> = {};
			// Whole seconds, as the server stores them.
			let interval: number | undefined;
			if (changed.autoSaveInterval !== undefined) {
				interval = Math.floor(changed.autoSaveInterval ?? AUTO_SAVE_MIN);
				body.autoSaveInterval = interval;
			}
			if (changed.undoSendSeconds !== undefined) body.undoSendSeconds = Number(changed.undoSendSeconds);
			if (changed.font !== undefined) body.font = changed.font;
			if (changed.fontSize !== undefined) body.fontSize = changed.fontSize;
			await sendJson('/api/preferences/composer', body);
			await invalidateAll();
			return interval === undefined ? undefined : { autoSaveInterval: interval };
		}
	});

	const fonts = [
		'Calibri', 'Segoe UI', 'Arial', 'Helvetica', 'Georgia', 'Times New Roman',
		'Courier New', 'Verdana', 'Tahoma', 'Trebuchet MS'
	];
</script>

<Section title="Composer" id="composer">
	<SettingRow title="Font">
		{#snippet control()}
			<Select
				value={draft.value.font}
				ariaLabel="Default font"
				onchange={(v) => (draft.value.font = v)}
				options={fonts.map((f) => ({ value: f, label: f }))}
			/>
			<Select
				value={draft.value.fontSize}
				ariaLabel="Default font size"
				onchange={(v) => (draft.value.fontSize = v)}
				options={['8', '9', '10', '11', '12', '14', '16', '18', '20', '24'].map((v) => ({ value: v, label: `${v} pt` }))}
			/>
		{/snippet}
	</SettingRow>

	<SettingRow title="Undo send">
		{#snippet control()}
			<Select
				value={draft.value.undoSendSeconds}
				ariaLabel="Undo send"
				onchange={(v) => (draft.value.undoSendSeconds = v)}
				options={[
					{ value: '0', label: 'Off' },
					{ value: '5', label: '5 seconds' },
					{ value: '10', label: '10 seconds' },
					{ value: '20', label: '20 seconds' },
					{ value: '30', label: '30 seconds' }
				]}
			/>
		{/snippet}
	</SettingRow>

	<SettingRow title="Save drafts every">
		{#snippet control()}
			<NumberInput
				bind:value={draft.value.autoSaveInterval}
				min={AUTO_SAVE_MIN}
				max={AUTO_SAVE_MAX}
				ariaLabel="Save drafts every (seconds)"
				width="80px"
			/>
			<span class="text-sm text-text-tertiary">seconds</span>
		{/snippet}
	</SettingRow>
</Section>
