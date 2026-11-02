<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import type { CalendarInfo, EventInstance } from '$lib/calendar/types';
	import { describeRRule } from '$lib/calendar/types';
	import { formatEventRange, instanceDate } from '$lib/calendar/dates';

	let {
		event,
		calendars,
		anchor,
		onEdit,
		onDelete,
		onClose
	}: {
		event: EventInstance;
		calendars: CalendarInfo[];
		/** Viewport rect of the clicked chip. */
		anchor: { x: number; y: number };
		onEdit: () => void;
		onDelete: () => void;
		onClose: () => void;
	} = $props();

	const calendar = $derived(calendars.find((c) => c.id === event.calendarId));
	const rangeText = $derived(
		formatEventRange(instanceDate(event.start, event.allDay), instanceDate(event.end, event.allDay), event.allDay)
	);

	let el = $state<HTMLDivElement | null>(null);
	let pos = $state({ left: 0, top: 0 });

	$effect(() => {
		// Clamp to viewport once rendered.
		const width = el?.offsetWidth ?? 320;
		const height = el?.offsetHeight ?? 220;
		let left = anchor.x + 8;
		let top = anchor.y + 8;
		if (left + width > window.innerWidth - 12) left = Math.max(12, anchor.x - width - 8);
		if (top + height > window.innerHeight - 12) top = Math.max(12, window.innerHeight - height - 12);
		pos = { left, top };
	});

	function alarmText(minutes: number): string {
		if (minutes === 0) return 'At time of event';
		if (minutes < 60) return `${minutes} minutes before`;
		if (minutes % 1440 === 0) return `${minutes / 1440} day${minutes === 1440 ? '' : 's'} before`;
		if (minutes % 60 === 0) return `${minutes / 60} hour${minutes === 60 ? '' : 's'} before`;
		return `${minutes} minutes before`;
	}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="fixed inset-0 z-[60]" onclick={onClose} onkeydown={(e) => e.key === 'Escape' && onClose()}>
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<div
		bind:this={el}
		class="fixed w-[320px] bg-surface border border-border rounded-xl shadow-[0_8px_32px_rgba(0,0,0,0.45)] p-4 animate-compose-modal-in"
		style="left: {pos.left}px; top: {pos.top}px;"
		onclick={(e) => e.stopPropagation()}
		role="dialog"
		aria-label={event.title || 'Event details'}
		tabindex="-1"
	>
		<div class="flex items-start justify-between gap-2 mb-2">
			<div class="flex items-start gap-2.5 min-w-0">
				<span class="w-3.5 h-3.5 rounded-md mt-1 shrink-0" style="background: {calendar?.color ?? '#0969da'};"></span>
				<div class="min-w-0">
					<h3 class="text-base font-semibold text-text leading-snug break-words">
						{event.title || '(untitled event)'}
					</h3>
					<!-- Date and times each stay whole; a narrow popover breaks
					     between them, not inside "7:00 PM – 8:00 PM". -->
					<p class="text-sm text-text-secondary mt-0.5">
						{#each rangeText.split(' · ') as part, i}
							<!-- eslint-disable-next-line svelte/no-useless-mustaches -- Svelte would trim plain spaces here -->
							{#if i > 0}{' · '}{/if}<span class="whitespace-nowrap">{part}</span>
						{/each}
					</p>
					{#if event.recurring}
						<p class="text-xs text-text-tertiary mt-0.5">{describeRRule(event.rrule)}</p>
					{/if}
				</div>
			</div>
			<div class="flex items-center gap-0.5 shrink-0">
				<button type="button" class="fc-btn" title="Edit" aria-label="Edit event" onclick={onEdit}>
					<Icon name="edit" size={16} />
				</button>
				<button type="button" class="fc-btn" title="Delete" aria-label="Delete event" onclick={onDelete}>
					<Icon name="delete" size={16} />
				</button>
				<button type="button" class="fc-btn" title="Close" aria-label="Close" onclick={onClose}>
					<Icon name="close" size={16} />
				</button>
			</div>
		</div>

		<div class="space-y-1.5 text-sm">
			{#if event.location}
				<div class="flex items-start gap-2 text-text-secondary">
					<Icon name="location" size={14} class="mt-0.5" />
					<span class="break-words">{event.location}</span>
				</div>
			{/if}
			{#if event.description}
				<div class="flex items-start gap-2 text-text-secondary">
					<Icon name="notes" size={14} class="mt-0.5" />
					<span class="break-words whitespace-pre-line line-clamp-5">{event.description}</span>
				</div>
			{/if}
			{#if event.alarms.length > 0}
				<div class="flex items-start gap-2 text-text-secondary">
					<Icon name="reminder" size={14} class="mt-0.5" />
					<span>{event.alarms.map(alarmText).join(', ')}</span>
				</div>
			{/if}
			{#if event.attendees.length > 0}
				<div class="flex items-start gap-2 text-text-secondary">
					<Icon name="guests" size={14} class="mt-0.5" />
					<span class="break-words">
						{event.attendees.length} guest{event.attendees.length === 1 ? '' : 's'}:
						{event.attendees.map((a) => a.name || a.email).join(', ')}
					</span>
				</div>
			{/if}
			{#if calendar}
				<div class="flex items-center gap-2 text-text-tertiary text-xs pt-1">
					<span class="w-2 h-2 rounded-full" style="background: {calendar.color};"></span>
					{calendar.name}
					{#if event.status !== 'confirmed'}
						<span class="uppercase tracking-wide">· {event.status}</span>
					{/if}
				</div>
			{/if}
		</div>
	</div>
</div>
