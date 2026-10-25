<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import { invalidateAll } from '$app/navigation';
	import type { CalendarInfo } from '$lib/calendar/types';
	import type { WeekStart } from '$lib/calendar/dates';
	import { apiDeleteCalendar, apiUpdateCalendar } from '$lib/calendar/api';
	import { showToast } from '$lib/stores/toast';
	import MiniMonth from './MiniMonth.svelte';
	import CalendarModal from './CalendarModal.svelte';

	let {
		calendars,
		selected,
		weekStart,
		onSelectDate
	}: {
		calendars: CalendarInfo[];
		selected: Date;
		weekStart: WeekStart;
		onSelectDate: (date: Date) => void;
	} = $props();

	let modalOpen = $state(false);
	let editingCalendar = $state<CalendarInfo | null>(null);
	let menuFor = $state<string | null>(null);
	let confirmDeleteFor = $state<string | null>(null);

	async function toggleVisibility(cal: CalendarInfo) {
		const res = await apiUpdateCalendar(cal.id, { hidden: !cal.hidden });
		if (!res.ok) {
			showToast({ message: res.error ?? 'Failed to update calendar' });
			return;
		}
		await invalidateAll();
	}

	async function handleDelete(cal: CalendarInfo) {
		confirmDeleteFor = null;
		menuFor = null;
		const res = await apiDeleteCalendar(cal.id);
		if (!res.ok) {
			showToast({ message: res.error ?? 'Failed to delete calendar' });
			return;
		}
		showToast({ message: `Deleted “${cal.name}”` });
		await invalidateAll();
	}

	function closeMenus() {
		menuFor = null;
		confirmDeleteFor = null;
	}
</script>

<svelte:window onclick={closeMenus} />

<!-- Rendered in the shell's left column, so it sits on the chrome like the
     mail sidebar. New event is in the corner's + menu. -->
<div class="h-full w-full flex flex-col overflow-y-auto">
	<div class="p-3">
		<MiniMonth {selected} {weekStart} onSelect={onSelectDate} />
	</div>

	<div class="px-3 pb-4 flex-1">
		<div class="flex items-center justify-between mb-1 px-1">
			<span class="text-xs font-semibold text-text-tertiary uppercase tracking-wide">My calendars</span>
			<button
				type="button"
				class="w-5 h-5 rounded-md flex items-center justify-center text-text-tertiary hover:text-text hover:bg-surface-hover transition-colors cursor-pointer"
				title="New calendar"
				aria-label="New calendar"
				onclick={() => {
					editingCalendar = null;
					modalOpen = true;
				}}
			>
				<Icon name="add" size={14} />
			</button>
		</div>

		{#each calendars as cal (cal.id)}
			<div class="group relative flex items-center gap-2 px-1.5 py-1 rounded-md hover:bg-surface-hover transition-colors">
				<input
					type="checkbox"
					checked={!cal.hidden}
					onchange={() => toggleVisibility(cal)}
					class="w-3.5 h-3.5 rounded-md cursor-pointer shrink-0"
					style="accent-color: {cal.color};"
					aria-label="Show {cal.name}"
				/>
				<span class="text-sm text-text flex-1 truncate" class:opacity-50={cal.hidden}>{cal.name}</span>
				<button
					type="button"
					class="w-5 h-5 pointer-coarse:w-8 pointer-coarse:h-8 rounded-md flex items-center justify-center text-text-tertiary hover:text-text opacity-0 group-hover:opacity-100 pointer-coarse:opacity-100 focus-visible:opacity-100 transition-opacity cursor-pointer"
					aria-label="Calendar options"
					onclick={(e) => {
						e.stopPropagation();
						confirmDeleteFor = null;
						menuFor = menuFor === cal.id ? null : cal.id;
					}}
				>
					<Icon name="more" size={14} />
				</button>

				{#if menuFor === cal.id}
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<!-- svelte-ignore a11y_click_events_have_key_events -->
					<div
						class="absolute right-0 top-7 z-30 w-44 bg-surface border border-border rounded-lg shadow-[0_8px_24px_rgba(0,0,0,0.4)] py-1"
						onclick={(e) => e.stopPropagation()}
					>
						<button
							type="button"
							class="w-full text-left px-3 py-1.5 text-sm text-text hover:bg-surface-hover transition-colors cursor-pointer"
							onclick={() => {
								editingCalendar = cal;
								modalOpen = true;
								menuFor = null;
							}}
						>
							Edit name & color
						</button>
						{#if !cal.isDefault}
							{#if confirmDeleteFor === cal.id}
								<button
									type="button"
									class="w-full text-left px-3 py-1.5 text-sm text-danger font-medium hover:bg-danger/10 transition-colors cursor-pointer"
									onclick={() => handleDelete(cal)}
								>
									Confirm delete — events are removed
								</button>
							{:else}
								<button
									type="button"
									class="w-full text-left px-3 py-1.5 text-sm text-danger hover:bg-danger/10 transition-colors cursor-pointer"
									onclick={() => (confirmDeleteFor = cal.id)}
								>
									Delete calendar…
								</button>
							{/if}
						{/if}
					</div>
				{/if}
			</div>
		{/each}
	</div>
</div>

<CalendarModal
	open={modalOpen}
	editing={editingCalendar}
	onClose={() => {
		modalOpen = false;
		editingCalendar = null;
	}}
/>
