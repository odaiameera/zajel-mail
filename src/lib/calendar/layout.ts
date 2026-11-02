import type { EventInstance } from './types';
import { addDays, dayKey, instanceDate, startOfDay } from './dates';

/**
 * Pure layout math for the calendar views.
 *
 * - Month / all-day rows: events become per-week *segments* (start column +
 *   span) stacked into lanes so multi-day chips never overlap.
 * - Time grid: overlapping timed events are clustered and split into
 *   side-by-side columns, Google-style.
 */

export interface WeekSegment {
	event: EventInstance;
	/** 0-6 column within the week row. */
	startCol: number;
	/** Number of columns covered (≥1). */
	span: number;
	/** Vertical stacking position. */
	lane: number;
	/** Continues from the previous week (render without rounded left edge). */
	continuesBefore: boolean;
	continuesAfter: boolean;
}

/** Local-day span of an instance: [firstDay, lastDay] inclusive. */
export function eventDaySpan(ev: EventInstance): { first: Date; last: Date } {
	const start = instanceDate(ev.start, ev.allDay);
	const end = instanceDate(ev.end, ev.allDay);
	const first = startOfDay(start);
	let last: Date;
	if (ev.allDay) {
		last = addDays(startOfDay(end), -1); // exclusive end
	} else {
		// A timed event ending exactly at midnight doesn't occupy the next day.
		const endDay = startOfDay(end);
		last = end.getTime() === endDay.getTime() ? addDays(endDay, -1) : endDay;
	}
	if (last < first) last = first;
	return { first, last };
}

/** True when the instance spans more than one local day (or is all-day). */
export function isSpanningChip(ev: EventInstance): boolean {
	if (ev.allDay) return true;
	const { first, last } = eventDaySpan(ev);
	return first.getTime() !== last.getTime();
}

const DAY_MS = 86400000;

function dayDiff(a: Date, b: Date): number {
	return Math.round((startOfDay(b).getTime() - startOfDay(a).getTime()) / DAY_MS);
}

/**
 * Lay spanning chips of one week row into lanes. `weekDays` must be the 7
 * consecutive days of the row.
 */
export function layoutWeekSegments(events: EventInstance[], weekDays: Date[]): WeekSegment[] {
	const weekStart = weekDays[0];
	const weekEndExclusive = addDays(weekDays[weekDays.length - 1], 1);

	const segs: Omit<WeekSegment, 'lane'>[] = [];
	for (const ev of events) {
		const { first, last } = eventDaySpan(ev);
		if (last < weekStart || first >= weekEndExclusive) continue;
		const startCol = Math.max(0, dayDiff(weekStart, first));
		const endCol = Math.min(weekDays.length - 1, dayDiff(weekStart, last));
		if (endCol < startCol) continue;
		segs.push({
			event: ev,
			startCol,
			span: endCol - startCol + 1,
			continuesBefore: first < weekStart,
			continuesAfter: last >= weekEndExclusive
		});
	}

	// Longer chips first so they take the upper lanes and short ones fill gaps.
	segs.sort((a, b) => a.startCol - b.startCol || b.span - a.span || a.event.start.localeCompare(b.event.start));

	const laneEnds: number[] = []; // last occupied column per lane
	const out: WeekSegment[] = [];
	for (const seg of segs) {
		let lane = laneEnds.findIndex((end) => end < seg.startCol);
		if (lane === -1) {
			lane = laneEnds.length;
			laneEnds.push(-1);
		}
		laneEnds[lane] = seg.startCol + seg.span - 1;
		out.push({ ...seg, lane });
	}
	return out;
}

export interface TimedBlock {
	event: EventInstance;
	/** Minutes from local midnight of the rendered day. */
	startMin: number;
	endMin: number;
	/** Horizontal fraction [0,1). */
	left: number;
	width: number;
}

/**
 * Clip a timed instance to one local day, in wall-clock minutes from that
 * day's midnight. Wall-clock rather than elapsed time: on the 25-hour
 * fall-back day an elapsed count draws every afternoon event an hour late
 * and loses the last hour entirely, while the hour labels, click-to-create
 * and the now-line all speak wall-clock. A zero-length event (a deadline, an
 * imported reminder) gets the same 15-minute floor as any short one instead
 * of vanishing from the grid.
 */
export function clipToDay(ev: EventInstance, day: Date): { startMin: number; endMin: number } | null {
	const dayStart = startOfDay(day);
	const nextDay = addDays(dayStart, 1);
	const s = new Date(ev.start);
	const e = new Date(ev.end);
	if (e <= dayStart || s >= nextDay) return null;
	const minutesOf = (d: Date) => d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
	const startMin = s < dayStart ? 0 : minutesOf(s);
	const endMin = e >= nextDay ? 1440 : minutesOf(e);
	return { startMin, endMin: Math.min(1440, Math.max(endMin, startMin + 15)) };
}

/**
 * Column layout for one day's timed events: cluster transitively
 * overlapping blocks, assign each a column greedily, share the width.
 */
export function layoutTimedBlocks(
	events: EventInstance[],
	day: Date
): TimedBlock[] {
	const blocks: { event: EventInstance; startMin: number; endMin: number; col: number }[] = [];
	for (const ev of events) {
		const clip = clipToDay(ev, day);
		if (clip) blocks.push({ event: ev, ...clip, col: 0 });
	}
	blocks.sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin);

	const out: TimedBlock[] = [];
	let cluster: typeof blocks = [];
	let clusterEnd = -1;

	const flush = () => {
		if (cluster.length === 0) return;
		const colEnds: number[] = [];
		for (const b of cluster) {
			let col = colEnds.findIndex((end) => end <= b.startMin);
			if (col === -1) {
				col = colEnds.length;
				colEnds.push(0);
			}
			b.col = col;
			colEnds[col] = b.endMin;
		}
		const cols = colEnds.length;
		for (const b of cluster) {
			out.push({
				event: b.event,
				startMin: b.startMin,
				endMin: b.endMin,
				left: b.col / cols,
				width: 1 / cols
			});
		}
		cluster = [];
	};

	for (const b of blocks) {
		if (cluster.length > 0 && b.startMin >= clusterEnd) {
			flush();
			clusterEnd = -1;
		}
		cluster.push(b);
		clusterEnd = Math.max(clusterEnd, b.endMin);
	}
	flush();
	return out;
}

/** Bucket single-day, timed instances by local day key. */
export function timedEventsByDay(events: EventInstance[]): Map<string, EventInstance[]> {
	const map = new Map<string, EventInstance[]>();
	for (const ev of events) {
		if (isSpanningChip(ev)) continue;
		const key = dayKey(instanceDate(ev.start, false));
		const list = map.get(key);
		if (list) list.push(ev);
		else map.set(key, [ev]);
	}
	return map;
}

/** Spanning chips (all-day + multi-day) only. */
export function spanningEvents(events: EventInstance[]): EventInstance[] {
	return events.filter(isSpanningChip);
}
