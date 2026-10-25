<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import { goto, invalidateAll } from '$app/navigation';
	import { pageTitle } from '$lib/utils/title';
	import type { EditScope, EventInstance, EventWritePayload } from '$lib/calendar/types';
	import {
		addDays,
		addMonths,
		dayKey,
		formatDayLong,
		fromDayKey,
		localTimeZone,
		monthGridDays,
		monthName,
		startOfWeek,
		toLocalWallClock,
		type WeekStart
	} from '$lib/calendar/dates';
	import { apiCreateEvent, apiDeleteEvent, apiUpdateEvent } from '$lib/calendar/api';
	import { showToast } from '$lib/stores/toast';
	import CalendarPanel from '$lib/components/calendar/CalendarPanel.svelte';
	import { appDrawerCloser, hostAppPanel } from '$lib/app-panel';
	import { newRequest } from '$lib/stores/create';
	import { untrack } from 'svelte';
	import MonthView from '$lib/components/calendar/MonthView.svelte';
	import TimeGrid from '$lib/components/calendar/TimeGrid.svelte';
	import EventModal from '$lib/components/calendar/EventModal.svelte';
	import EventPopover from '$lib/components/calendar/EventPopover.svelte';
	import ScopeDialog from '$lib/components/calendar/ScopeDialog.svelte';
	import ImportEventsModal from '$lib/components/calendar/ImportEventsModal.svelte';
	import type { ImportBatchResult } from '$lib/calendar/api';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const selectedDate = $derived(fromDayKey(data.date));
	const weekStart = $derived(data.weekStart as WeekStart);

	const monthDays = $derived(
		monthGridDays(selectedDate.getFullYear(), selectedDate.getMonth(), weekStart)
	);

	// All time-grid views are just different day windows over the same grid.
	const gridDays = $derived.by(() => {
		switch (data.view) {
			case 'week':
				return Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(selectedDate, weekStart), i));
			case 'workweek':
				// Mon–Fri of the week containing the date, regardless of week-start pref.
				return Array.from({ length: 5 }, (_, i) => addDays(startOfWeek(selectedDate, 1), i));
			case '3day':
				return [selectedDate, addDays(selectedDate, 1), addDays(selectedDate, 2)];
			default:
				return [selectedDate];
		}
	});

	const VIEW_OPTIONS: { value: string; label: string; shortcut: string }[] = [
		{ value: 'day', label: 'Day', shortcut: 'D' },
		{ value: '3day', label: '3 days', shortcut: '3' },
		{ value: 'workweek', label: 'Work week', shortcut: 'F' },
		{ value: 'week', label: 'Week', shortcut: 'W' },
		{ value: 'month', label: 'Month', shortcut: 'M' }
	];
	const currentViewLabel = $derived(
		VIEW_OPTIONS.find((v) => v.value === data.view)?.label ?? 'Month'
	);
	let viewMenuOpen = $state(false);

	// formatRange collapses the shared parts per locale ("Oct 19 – 25, 2026",
	// "19–25 Oct 2026"). Formatting the right side by hand without its month
	// asked Intl for a bare {day, year}, which Chrome renders as
	// "2026 (day: 25)".
	const rangeFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

	function rangeLabel(days: Date[]): string {
		return rangeFormat.formatRange(days[0], days[days.length - 1]);
	}

	const headerLabel = $derived.by(() => {
		if (data.view === 'month') {
			return `${monthName(selectedDate.getMonth())} ${selectedDate.getFullYear()}`;
		}
		if (data.view === 'day') return formatDayLong(selectedDate);
		return rangeLabel(gridDays);
	});

	function navigate(view: string, date: Date) {
		// A different view (from the menu or a shortcut) is remembered, so
		// Calendar opens on it next time.
		if (view !== data.view) {
			void fetch('/api/preferences/calendar', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ view })
			}).catch(() => {});
		}
		goto(`/calendar?view=${view}&date=${dayKey(date)}`, { noScroll: true, keepFocus: true });
	}

	function step(direction: 1 | -1) {
		switch (data.view) {
			case 'month':
				navigate('month', addMonths(selectedDate, direction));
				break;
			case 'week':
			case 'workweek':
				navigate(data.view, addDays(selectedDate, 7 * direction));
				break;
			case '3day':
				navigate('3day', addDays(selectedDate, 3 * direction));
				break;
			default:
				navigate('day', addDays(selectedDate, direction));
		}
	}

	// ----- event modal / popover / scope dialog --------------------------

	let modalOpen = $state(false);
	let editingInstance = $state<EventInstance | null>(null);
	let prefill = $state<{ start: Date; end: Date; allDay: boolean } | null>(null);
	let popover = $state<{ event: EventInstance; x: number; y: number } | null>(null);

	let scopeOpen = $state(false);
	let scopeAction = $state<'edit' | 'delete'>('edit');
	let scopeResolver: ((scope: EditScope | null) => void) | null = null;

	function askScope(action: 'edit' | 'delete'): Promise<EditScope | null> {
		scopeAction = action;
		scopeOpen = true;
		return new Promise((resolve) => {
			scopeResolver = resolve;
		});
	}

	function resolveScope(scope: EditScope | null) {
		scopeOpen = false;
		scopeResolver?.(scope);
		scopeResolver = null;
	}

	function openCreate(at?: { start: Date; end: Date; allDay: boolean }) {
		editingInstance = null;
		prefill = at ?? null;
		modalOpen = true;
	}

	function openEdit(ev: EventInstance) {
		popover = null;
		editingInstance = ev;
		prefill = null;
		modalOpen = true;
	}

	async function submitModal(payload: EventWritePayload): Promise<{ ok: boolean; error?: string }> {
		if (editingInstance) {
			let scope: EditScope = 'all';
			if (editingInstance.recurring) {
				const s = await askScope('edit');
				if (!s) return { ok: false }; // user backed out — keep the modal open
				scope = s;
			}
			const res = await apiUpdateEvent(editingInstance.id, payload, scope, editingInstance.recurrenceId);
			if (!res.ok) return { ok: false, error: res.error ?? 'Failed to save event' };
		} else {
			const res = await apiCreateEvent(payload);
			if (!res.ok) return { ok: false, error: res.error ?? 'Failed to create event' };
		}
		await invalidateAll();
		return { ok: true };
	}

	async function deleteFromPopover(ev: EventInstance) {
		let scope: EditScope = 'all';
		if (ev.recurring) {
			const s = await askScope('delete');
			if (!s) return;
			scope = s;
		}
		popover = null;
		const res = await apiDeleteEvent(ev.id, scope, ev.recurrenceId);
		if (!res.ok) {
			showToast({ message: res.error ?? 'Failed to delete event' });
			return;
		}
		showToast({ message: 'Event deleted' });
		await invalidateAll();
	}

	function payloadFromInstance(
		ev: EventInstance,
		start: Date,
		end: Date
	): EventWritePayload {
		return {
			calendarId: ev.calendarId,
			title: ev.title,
			allDay: false,
			start: toLocalWallClock(start),
			end: toLocalWallClock(end),
			timeZone: localTimeZone(),
			description: ev.description,
			location: ev.location,
			rrule: ev.rrule,
			alarms: ev.alarms,
			attendees: ev.attendees,
			status: ev.status
		};
	}

	async function moveEvent(ev: EventInstance, newStart: Date, newEnd: Date) {
		let scope: EditScope = 'all';
		if (ev.recurring) {
			const s = await askScope('edit');
			if (!s) return;
			scope = s;
		}
		const res = await apiUpdateEvent(ev.id, payloadFromInstance(ev, newStart, newEnd), scope, ev.recurrenceId);
		if (!res.ok) {
			showToast({ message: res.error ?? 'Failed to move event' });
			return;
		}
		await invalidateAll();
	}

	function showPopover(ev: EventInstance, x: number, y: number) {
		popover = { event: ev, x, y };
	}

	function handleKeydown(e: KeyboardEvent) {
		if (modalOpen || scopeOpen || importOpen) return;
		const target = e.target as HTMLElement | null;
		if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
		if (e.metaKey || e.ctrlKey || e.altKey) return;
		switch (e.key) {
			case 't':
				navigate(data.view, new Date());
				break;
			case 'm':
				navigate('month', selectedDate);
				break;
			case 'w':
				navigate('week', selectedDate);
				break;
			case 'f':
				navigate('workweek', selectedDate);
				break;
			case '3':
				navigate('3day', selectedDate);
				break;
			case 'd':
				navigate('day', selectedDate);
				break;
			case 'c':
				openCreate();
				break;
			case 'ArrowLeft':
				step(-1);
				break;
			case 'ArrowRight':
				step(1);
				break;
		}
	}

	// ----- import -------------------------------------------------------

	let importOpen = $state(false);
	const closeDrawer = appDrawerCloser();

	function openImport() {
		closeDrawer();
		importOpen = true;
	}

	async function afterImport(result: ImportBatchResult) {
		// A single event (an invitation or a booking saved as .ics) is shown
		// where it landed; a whole calendar leaves the view where it was.
		await invalidateAll();
		if (result.imported === 1 && result.firstDay) navigate(data.view, fromDayKey(result.firstDay));
	}

	// The mini-month and the calendar list live in the shell's left column
	// (the drawer on phones), where Mail keeps its folders.
	hostAppPanel(calendarPanel);

	// New event from the corner's + menu, here already or arriving now.
	$effect(() => {
		if ($newRequest !== 'event') return;
		newRequest.set(null);
		untrack(() => openCreate());
	});
</script>

{#snippet calendarPanel()}
	<CalendarPanel
		calendars={data.calendars}
		selected={selectedDate}
		{weekStart}
		onSelectDate={(date) => navigate(data.view, date)}
		onImport={openImport}
	/>
{/snippet}

<svelte:head>
	<title>{pageTitle({ page: 'Calendar' })}</title>
</svelte:head>

<svelte:window onkeydown={handleKeydown} onclick={() => (viewMenuOpen = false)} />

<div class="h-full flex min-h-0">
	<div class="flex-1 flex flex-col min-w-0 min-h-0">
		<!-- Toolbar -->
		<div class="flex items-center gap-2 px-4 max-md:px-2 h-12 border-b border-border shrink-0">
			<button
				type="button"
				class="btn btn-secondary btn-sm"
				onclick={() => navigate(data.view, new Date())}
			>
				Today
			</button>
			<div class="flex items-center">
				<button type="button" class="fc-btn" aria-label="Previous" onclick={() => step(-1)}>
					<Icon name="previous" size={16} />
				</button>
				<button type="button" class="fc-btn" aria-label="Next" onclick={() => step(1)}>
					<Icon name="next" size={16} />
				</button>
			</div>
			<h1 class="text-base font-semibold text-text truncate">{headerLabel}</h1>
			<div class="flex-1"></div>
			<!-- Single view dropdown (Google-style) keeps the toolbar compact
			     as views multiply; shortcuts work everywhere on the page. -->
			<div class="relative">
				<button
					type="button"
					class="btn btn-secondary btn-sm"
					aria-haspopup="listbox"
					aria-expanded={viewMenuOpen}
					onclick={(e) => {
						e.stopPropagation();
						viewMenuOpen = !viewMenuOpen;
					}}
				>
					{currentViewLabel}
					<Icon name="dropdown" size={14} class="text-text-tertiary" />
				</button>
				{#if viewMenuOpen}
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<!-- svelte-ignore a11y_click_events_have_key_events -->
					<div
						class="absolute right-0 top-9 z-40 w-44 bg-surface border border-border rounded-lg shadow-[0_8px_24px_rgba(0,0,0,0.4)] py-1"
						role="listbox"
						onclick={(e) => e.stopPropagation()}
					>
						{#each VIEW_OPTIONS as opt (opt.value)}
							<button
								type="button"
								role="option"
								aria-selected={data.view === opt.value}
								class="w-full flex items-center justify-between px-3 py-1.5 text-sm transition-colors cursor-pointer
									{data.view === opt.value ? 'text-accent-fg font-medium' : 'text-text hover:bg-surface-hover'}"
								onclick={() => {
									viewMenuOpen = false;
									navigate(opt.value, selectedDate);
								}}
							>
								{opt.label}
								<span class="text-3xs text-text-tertiary border border-border rounded-md px-1 py-px">{opt.shortcut}</span>
							</button>
						{/each}
					</div>
				{/if}
			</div>
		</div>

		{#if data.calendarError}
			<div class="mx-4 mt-3 px-3 py-2 rounded-lg bg-danger/10 text-danger text-sm">
				Couldn't reach the calendar server. Events may be out of date — try reloading.
				{#if data.calendarErrorDetail}
					<span class="block mt-1 text-xs text-danger/80 font-mono break-all">{data.calendarErrorDetail}</span>
				{/if}
			</div>
		{/if}

		<!-- View -->
		<div class="flex-1 min-h-0">
			{#if data.view === 'month'}
				<MonthView
					days={monthDays}
					monthIndex={selectedDate.getMonth()}
					events={data.events}
					calendars={data.calendars}
					{weekStart}
					onSelectDay={(day) => navigate('day', day)}
					onCreateAt={(day) =>
						openCreate({
							start: new Date(day.getFullYear(), day.getMonth(), day.getDate(), 9, 0),
							end: new Date(day.getFullYear(), day.getMonth(), day.getDate(), 10, 0),
							allDay: false
						})}
					onEventClick={showPopover}
				/>
			{:else}
				<TimeGrid
					days={gridDays}
					events={data.events}
					calendars={data.calendars}
					onCreateRange={(start, end) => openCreate({ start, end, allDay: false })}
					onEventClick={showPopover}
					onEventMove={moveEvent}
					onSelectDay={(day) => navigate('day', day)}
				/>
			{/if}
		</div>
	</div>
</div>

<EventModal
	open={modalOpen}
	calendars={data.calendars}
	editing={editingInstance}
	{prefill}
	onSubmit={submitModal}
	onClose={() => {
		modalOpen = false;
		editingInstance = null;
		prefill = null;
	}}
/>

{#if popover}
	<EventPopover
		event={popover.event}
		calendars={data.calendars}
		anchor={{ x: popover.x, y: popover.y }}
		onEdit={() => openEdit(popover!.event)}
		onDelete={() => deleteFromPopover(popover!.event)}
		onClose={() => (popover = null)}
	/>
{/if}

<ScopeDialog open={scopeOpen} action={scopeAction} onResolve={resolveScope} />

<ImportEventsModal
	open={importOpen}
	calendars={data.calendars}
	onClose={() => (importOpen = false)}
	onImported={afterImport}
/>
