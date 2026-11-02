<script lang="ts">
	import { onMount } from 'svelte';
	import type { CalendarInfo, EventInstance } from '$lib/calendar/types';
	import { DEFAULT_CALENDAR_COLOR } from '$lib/calendar/types';
	import { dayKey, formatTime, instanceDate, sameDay } from '$lib/calendar/dates';
	import { layoutTimedBlocks, spanningEvents, timedEventsByDay, layoutWeekSegments } from '$lib/calendar/layout';

	let {
		days,
		events,
		calendars,
		onCreateRange,
		onEventClick,
		onEventMove,
		onSelectDay
	}: {
		/** Consecutive local days (7 for week view, 1 for day view). */
		days: Date[];
		events: EventInstance[];
		calendars: CalendarInfo[];
		onCreateRange: (start: Date, end: Date) => void;
		onEventClick: (ev: EventInstance, x: number, y: number) => void;
		/** Reschedule from drag/resize. */
		onEventMove: (ev: EventInstance, newStart: Date, newEnd: Date) => void;
		onSelectDay: (day: Date) => void;
	} = $props();

	const HOUR_H = 48;
	const SNAP = 15;
	const DRAG_THRESHOLD_PX = 5;

	const colorOf = $derived(new Map(calendars.map((c) => [c.id, c.color])));
	const timedByDay = $derived(timedEventsByDay(events));
	const allDaySegs = $derived(layoutWeekSegments(spanningEvents(events), days));
	const allDayLanes = $derived(allDaySegs.reduce((m, s) => Math.max(m, s.lane + 1), 0));
	const today = new Date();

	const hours = Array.from({ length: 24 }, (_, h) => h);
	function hourLabel(h: number): string {
		const d = new Date(2000, 0, 1, h, 0, 0);
		return d.toLocaleTimeString(undefined, { hour: 'numeric' });
	}

	let scrollEl = $state<HTMLDivElement | null>(null);
	let columnsEl = $state<HTMLDivElement | null>(null);

	// Current-time indicator, refreshed every 30s.
	let nowMs = $state(Date.now());
	onMount(() => {
		const t = setInterval(() => (nowMs = Date.now()), 30_000);
		// Open scrolled to the working morning, like Google Calendar.
		if (scrollEl) scrollEl.scrollTop = 7 * HOUR_H;
		return () => clearInterval(t);
	});
	const nowMin = $derived.by(() => {
		const d = new Date(nowMs);
		return d.getHours() * 60 + d.getMinutes();
	});
	const todayIdx = $derived(days.findIndex((d) => sameDay(d, new Date(nowMs))));

	// ----- pointer interactions ------------------------------------------

	type Drag =
		| { kind: 'create'; dayIdx: number; anchorMin: number; curMin: number; moved: boolean }
		| {
				kind: 'move';
				ev: EventInstance;
				durMin: number;
				dayIdx: number;
				startMin: number;
				offsetMin: number;
				moved: boolean;
				startX: number;
				startY: number;
		  }
		| {
				kind: 'resize';
				ev: EventInstance;
				dayIdx: number;
				startMin: number;
				curEndMin: number;
				moved: boolean;
				startY: number;
		  };

	let drag = $state<Drag | null>(null);

	function snap(min: number): number {
		return Math.round(min / SNAP) * SNAP;
	}

	function pointToCell(e: PointerEvent): { dayIdx: number; minute: number } | null {
		if (!columnsEl) return null;
		const rect = columnsEl.getBoundingClientRect();
		const x = e.clientX - rect.left;
		const y = e.clientY - rect.top;
		const colWidth = rect.width / days.length;
		const dayIdx = Math.max(0, Math.min(days.length - 1, Math.floor(x / colWidth)));
		const minute = Math.max(0, Math.min(1440, (y / HOUR_H) * 60));
		return { dayIdx, minute };
	}

	function gridPointerDown(e: PointerEvent) {
		if (e.button !== 0) return;
		const cell = pointToCell(e);
		if (!cell) return;
		const anchor = Math.min(1440 - SNAP, snap(cell.minute - SNAP / 2));
		drag = { kind: 'create', dayIdx: cell.dayIdx, anchorMin: anchor, curMin: anchor + SNAP, moved: false };
	}

	function blockPointerDown(e: PointerEvent, ev: EventInstance, dayIdx: number, startMin: number, endMin: number) {
		if (e.button !== 0) return;
		e.stopPropagation();
		const cell = pointToCell(e);
		if (!cell) return;
		drag = {
			kind: 'move',
			ev,
			durMin: endMin - startMin,
			dayIdx,
			startMin,
			offsetMin: cell.minute - startMin,
			moved: false,
			startX: e.clientX,
			startY: e.clientY
		};
	}

	function resizePointerDown(e: PointerEvent, ev: EventInstance, dayIdx: number, startMin: number, endMin: number) {
		if (e.button !== 0) return;
		e.stopPropagation();
		drag = { kind: 'resize', ev, dayIdx, startMin, curEndMin: endMin, moved: false, startY: e.clientY };
	}

	function windowPointerMove(e: PointerEvent) {
		if (!drag) return;
		const cell = pointToCell(e);
		if (!cell) return;
		if (drag.kind === 'create') {
			const cur = snap(cell.minute);
			drag = { ...drag, curMin: cur, moved: drag.moved || Math.abs(cur - drag.anchorMin) >= SNAP };
		} else if (drag.kind === 'move') {
			const movedFar =
				Math.abs(e.clientX - drag.startX) > DRAG_THRESHOLD_PX ||
				Math.abs(e.clientY - drag.startY) > DRAG_THRESHOLD_PX;
			if (!drag.moved && !movedFar) return;
			let newStart = snap(cell.minute - drag.offsetMin);
			newStart = Math.max(0, Math.min(1440 - drag.durMin, newStart));
			drag = { ...drag, dayIdx: cell.dayIdx, startMin: newStart, moved: true };
		} else {
			// Same threshold as a move: the handle is the bottom 6px of every
			// block, so a plain click there must stay a click, not a save.
			if (!drag.moved && Math.abs(e.clientY - drag.startY) <= DRAG_THRESHOLD_PX) return;
			const end = Math.max(drag.startMin + SNAP, snap(cell.minute));
			drag = { ...drag, curEndMin: Math.min(1440, end), moved: true };
		}
	}

	function minutesToDate(day: Date, minutes: number): Date {
		return new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, minutes, 0);
	}

	function windowPointerUp(e: PointerEvent) {
		if (!drag) return;
		const d = drag;
		drag = null;
		if (d.kind === 'create') {
			const lo = Math.min(d.anchorMin, d.curMin);
			const hi = d.moved ? Math.max(d.anchorMin, d.curMin, lo + SNAP) : lo + 60;
			onCreateRange(minutesToDate(days[d.dayIdx], lo), minutesToDate(days[d.dayIdx], Math.min(1440, hi)));
		} else if (d.kind === 'move') {
			if (!d.moved) {
				onEventClick(d.ev, e.clientX, e.clientY);
				return;
			}
			const start = minutesToDate(days[d.dayIdx], d.startMin);
			const end = minutesToDate(days[d.dayIdx], d.startMin + d.durMin);
			onEventMove(d.ev, start, end);
		} else {
			if (!d.moved) {
				onEventClick(d.ev, e.clientX, e.clientY);
				return;
			}
			const orig = instanceDate(d.ev.start, false);
			const end = minutesToDate(days[d.dayIdx], d.curEndMin);
			onEventMove(d.ev, orig, end);
		}
	}

	function blockTextColor(): string {
		return '#fff';
	}

	const dragGhost = $derived.by(() => {
		if (!drag) return null;
		if (drag.kind === 'create' && drag.moved !== undefined) {
			const lo = Math.min(drag.anchorMin, drag.curMin);
			const hi = Math.max(drag.anchorMin, drag.curMin, lo + SNAP);
			return { dayIdx: drag.dayIdx, startMin: lo, endMin: hi, label: 'New event', color: null as string | null };
		}
		if (drag.kind === 'move' && drag.moved) {
			return {
				dayIdx: drag.dayIdx,
				startMin: drag.startMin,
				endMin: drag.startMin + drag.durMin,
				label: drag.ev.title || '(untitled)',
				color: colorOf.get(drag.ev.calendarId) ?? DEFAULT_CALENDAR_COLOR
			};
		}
		if (drag.kind === 'resize' && drag.moved) {
			return {
				dayIdx: drag.dayIdx,
				startMin: drag.startMin,
				endMin: drag.curEndMin,
				label: drag.ev.title || '(untitled)',
				color: colorOf.get(drag.ev.calendarId) ?? DEFAULT_CALENDAR_COLOR
			};
		}
		return null;
	});
</script>

<!-- pointercancel: a touch that turns into a scroll never sends pointerup, and
     a drag left behind would be carried out by the next tap anywhere. -->
<svelte:window onpointermove={windowPointerMove} onpointerup={windowPointerUp} onpointercancel={() => (drag = null)} />

<div class="h-full flex flex-col min-h-0 select-none">
	<!-- Day headers. The header, all-day lane and grid all keep room for the
	     grid's scrollbar (scrollbar-gutter), so their columns line up; the
	     header used to spread that width across its days and drift right. -->
	<div class="flex border-b border-border overflow-y-hidden [scrollbar-gutter:stable]">
		<div class="w-14 shrink-0"></div>
		{#each days as day (dayKey(day))}
			{@const isToday = sameDay(day, today)}
			<button
				type="button"
				class="flex-1 py-1.5 flex flex-col items-center gap-0.5 hover:bg-surface-hover/40 transition-colors cursor-pointer border-l border-border first:border-l-0"
				onclick={() => onSelectDay(day)}
			>
				<span class="text-2xs font-medium uppercase tracking-wide {isToday ? 'text-accent-fg' : 'text-text-tertiary'}">
					{day.toLocaleDateString(undefined, { weekday: 'short' })}
				</span>
				<span
					class="w-7 h-7 rounded-full text-sm flex items-center justify-center
						{isToday ? 'bg-accent text-white font-semibold' : 'text-text'}"
				>
					{day.getDate()}
				</span>
			</button>
		{/each}
	</div>

	<!-- All-day lane -->
	{#if allDaySegs.length > 0}
		<div class="flex border-b border-border overflow-y-hidden [scrollbar-gutter:stable]">
			<div class="w-14 shrink-0 py-1 pr-2 text-right text-3xs text-text-tertiary">all-day</div>
			<div class="flex-1 relative" style="height: {Math.max(1, allDayLanes) * 22 + 4}px;">
				{#each allDaySegs as seg (seg.event.id + (seg.event.recurrenceId ?? '') + seg.startCol)}
					<button
						type="button"
						class="absolute h-[20px] px-1.5 flex items-center text-2xs text-white font-medium truncate cursor-pointer hover:opacity-90 transition-opacity
							{seg.continuesBefore ? '' : 'rounded-l'} {seg.continuesAfter ? '' : 'rounded-r'}"
						style="
							top: {2 + seg.lane * 22}px;
							left: calc({(seg.startCol / days.length) * 100}% + 2px);
							width: calc({(seg.span / days.length) * 100}% - 4px);
							background: {colorOf.get(seg.event.calendarId) ?? DEFAULT_CALENDAR_COLOR};
						"
						onclick={(e) => onEventClick(seg.event, e.clientX, e.clientY)}
					>
						<span class="truncate">{seg.event.title || '(untitled)'}</span>
					</button>
				{/each}
			</div>
		</div>
	{/if}

	<!-- Scrollable time grid -->
	<div bind:this={scrollEl} class="flex-1 overflow-y-auto min-h-0 [scrollbar-gutter:stable]">
		<div class="flex" style="height: {24 * HOUR_H}px;">
			<!-- Hour gutter -->
			<div class="w-14 shrink-0 relative">
				{#each hours as h (h)}
					{#if h > 0}
						<span class="absolute right-2 -translate-y-1/2 text-3xs text-text-tertiary" style="top: {h * HOUR_H}px;">
							{hourLabel(h)}
						</span>
					{/if}
				{/each}
			</div>

			<!-- Day columns -->
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div bind:this={columnsEl} data-time-grid-columns class="flex-1 relative flex" onpointerdown={gridPointerDown}>
				<!-- Hour lines -->
				{#each hours as h (h)}
					{#if h > 0}
						<div class="absolute inset-x-0 border-t border-border/60 pointer-events-none" style="top: {h * HOUR_H}px;"></div>
					{/if}
				{/each}

				{#each days as day, di (dayKey(day))}
					{@const blocks = layoutTimedBlocks(timedByDay.get(dayKey(day)) ?? [], day)}
					<div class="flex-1 relative border-l border-border first:border-l-0">
						{#each blocks as block (block.event.id + (block.event.recurrenceId ?? ''))}
							{@const color = colorOf.get(block.event.calendarId) ?? DEFAULT_CALENDAR_COLOR}
							{@const hidden =
								drag &&
								((drag.kind === 'move' && drag.moved) || drag.kind === 'resize') &&
								drag.ev.id === block.event.id &&
								drag.ev.recurrenceId === block.event.recurrenceId}
							<!-- svelte-ignore a11y_no_static_element_interactions -->
							<div
								class="absolute rounded-md px-1.5 py-0.5 overflow-hidden cursor-grab active:cursor-grabbing transition-opacity {hidden ? 'opacity-30' : 'hover:brightness-110'}"
								style="
									top: {(block.startMin / 60) * HOUR_H + 1}px;
									height: {Math.max(14, ((block.endMin - block.startMin) / 60) * HOUR_H - 2)}px;
									left: calc({block.left * 100}% + 1px);
									width: calc({block.width * 100}% - 3px);
									background: {color};
									color: {blockTextColor()};
								"
								onpointerdown={(e) => blockPointerDown(e, block.event, di, block.startMin, block.endMin)}
							>
								<div class="text-2xs font-semibold leading-tight truncate">
									{block.event.title || '(untitled)'}
								</div>
								{#if block.endMin - block.startMin >= 40}
									<div class="text-3xs opacity-85 leading-tight truncate">
										{formatTime(instanceDate(block.event.start, false))} – {formatTime(instanceDate(block.event.end, false))}
									</div>
								{/if}
								<!-- Resize handle -->
								<div
									class="absolute inset-x-0 bottom-0 h-[6px] cursor-ns-resize"
									onpointerdown={(e) => resizePointerDown(e, block.event, di, block.startMin, block.endMin)}
								></div>
							</div>
						{/each}
					</div>
				{/each}

				<!-- Drag ghost -->
				{#if dragGhost}
					<div
						class="absolute rounded-md px-1.5 py-0.5 pointer-events-none z-20 border-2 overflow-hidden"
						style="
							top: {(dragGhost.startMin / 60) * HOUR_H + 1}px;
							height: {Math.max(14, ((dragGhost.endMin - dragGhost.startMin) / 60) * HOUR_H - 2)}px;
							left: calc({(dragGhost.dayIdx / days.length) * 100}% + 2px);
							width: calc({(1 / days.length) * 100}% - 5px);
							background: {dragGhost.color ? dragGhost.color + 'CC' : 'color-mix(in srgb, var(--color-accent) 30%, transparent)'};
							border-color: {dragGhost.color ?? 'var(--color-accent)'};
						"
					>
						<div class="text-2xs font-semibold text-white leading-tight truncate">{dragGhost.label}</div>
						<div class="text-3xs text-white/90 leading-tight">
							{formatTime(minutesToDate(days[dragGhost.dayIdx], dragGhost.startMin))} – {formatTime(minutesToDate(days[dragGhost.dayIdx], dragGhost.endMin))}
						</div>
					</div>
				{/if}

				<!-- Current time indicator -->
				{#if todayIdx >= 0}
					<div class="absolute inset-x-0 pointer-events-none z-10" style="top: {(nowMin / 60) * HOUR_H}px;">
						<div class="h-[2px] bg-danger/80"></div>
						<div
							class="absolute w-2.5 h-2.5 rounded-full bg-danger -translate-y-1/2 top-[1px]"
							style="left: calc({(todayIdx / days.length) * 100}% - 4px);"
						></div>
					</div>
				{/if}
			</div>
		</div>
	</div>
</div>
