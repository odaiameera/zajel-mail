import { browser } from '$app/environment';
import { invalidateAll, goto } from '$app/navigation';
import { showToast } from './toast';
import { wasTouchedRecently } from '$lib/calendar/api';
import { canNotify, showNotification } from '$lib/notifications';

/**
 * Calendar notification engine. Polls `/api/calendar/poll` (CalDAV
 * sync-collection under the hood) so events created or changed from any
 * device trigger a desktop notification, and schedules local timers for
 * VALARM reminders ("Event in 10 minutes") — matching what Google/Apple
 * calendars do while a tab is open.
 *
 * Dedupe state lives in localStorage so reloads don't re-fire:
 *  - sync tokens   → only post-baseline changes notify
 *  - fired alarms  → each occurrence+lead-time fires once
 *  - touched ids   → our own edits (marked by the API helper) stay silent
 */

// 5 minutes: calendar changes from other devices are ambient information,
// not chat — and each poll costs the mail server a PROPFIND plus two
// REPORTs per calendar. Reminder precision doesn't suffer: VALARMs are
// scheduled as local timers from each poll's 30-minute horizon.
const POLL_INTERVAL_MS = 5 * 60_000;
const TOKENS_KEY = 'cal-sync-tokens-v1';
const FIRED_KEY = 'cal-fired-alarms-v1';
const LAST_POLL_KEY = 'cal-last-poll-v1';
const FIRED_TTL_MS = 2 * 86400000;

interface ReminderItem {
	key: string;
	eventId: string;
	title: string;
	start: string;
	allDay: boolean;
	fireAt: number;
	minutesBefore: number;
}

interface ChangedEvent {
	id: string;
	calendarId: string;
	uid: string;
	title: string;
	start: string;
	allDay: boolean;
}

export interface CalendarNotifyOptions {
	newEvents: boolean;
	reminders: boolean;
	/** This device gets reminders by push, so only the in-app toast shows here. */
	remindersByPush?: boolean;
}

function readJson<T>(key: string, fallback: T): T {
	try {
		const raw = localStorage.getItem(key);
		return raw ? (JSON.parse(raw) as T) : fallback;
	} catch {
		return fallback;
	}
}

function writeJson(key: string, value: unknown): void {
	try {
		localStorage.setItem(key, JSON.stringify(value));
	} catch {
		// Best-effort.
	}
}

function formatStart(start: string, allDay: boolean): string {
	if (!start) return '';
	const d = allDay ? new Date(`${start}T00:00:00`) : new Date(start);
	if (isNaN(d.getTime())) return '';
	const day = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
	if (allDay) return day;
	return `${day} · ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
}

function createCalendarNotify() {
	let timer: ReturnType<typeof setInterval> | null = null;
	let options: CalendarNotifyOptions = { newEvents: true, reminders: true };
	let reminderTimers: ReturnType<typeof setTimeout>[] = [];
	let polling = false;

	function clearReminderTimers() {
		for (const t of reminderTimers) clearTimeout(t);
		reminderTimers = [];
	}

	function fireReminder(item: ReminderItem) {
		const fired = readJson<Record<string, number>>(FIRED_KEY, {});
		if (fired[item.key]) return;
		const now = Date.now();
		for (const [k, ts] of Object.entries(fired)) {
			if (now - ts > FIRED_TTL_MS) delete fired[k];
		}
		fired[item.key] = now;
		writeJson(FIRED_KEY, fired);

		const when =
			item.minutesBefore === 0
				? 'now'
				: item.minutesBefore < 60
					? `in ${item.minutesBefore} min`
					: formatStart(item.start, item.allDay);
		const title = item.title || '(untitled event)';
		if (canNotify() && !options.remindersByPush) {
			void showNotification(`${title} — ${when}`, {
				body: formatStart(item.start, item.allDay),
				tag: `ameera-cal-reminder-${item.key}`,
				url: '/calendar'
			});
		}
		showToast({
			message: `Reminder: ${title} ${when}`,
			action: { label: 'Open', onClick: () => goto('/calendar') },
			duration: 8000
		});
	}

	function scheduleReminders(items: ReminderItem[]) {
		if (!options.reminders) return;
		clearReminderTimers();
		const fired = readJson<Record<string, number>>(FIRED_KEY, {});
		const now = Date.now();
		for (const item of items) {
			if (fired[item.key]) continue;
			const delay = Math.max(0, item.fireAt - now);
			// Only schedule within the poll horizon; the next poll re-schedules.
			if (delay > POLL_INTERVAL_MS * 25) continue;
			reminderTimers.push(setTimeout(() => fireReminder(item), delay));
		}
	}

	function notifyChanged(changed: ChangedEvent[]) {
		if (!options.newEvents) return;
		const fresh = changed.filter((c) => !wasTouchedRecently(c.id));
		if (fresh.length === 0) return;

		for (const ev of fresh.slice(0, 5)) {
			const when = formatStart(ev.start, ev.allDay);
			if (canNotify()) {
				void showNotification(`Calendar: ${ev.title}`, {
					body: when ? `New or updated event · ${when}` : 'New or updated event',
					tag: `ameera-cal-event-${ev.uid}`,
					url: '/calendar'
				});
			}
		}
		const label = fresh.length === 1 ? `Event: ${fresh[0].title}` : `${fresh.length} calendar updates`;
		showToast({
			message: label,
			action: { label: 'View', onClick: () => goto('/calendar') }
		});
		// Refresh the calendar view if it's on screen.
		if (window.location.pathname.startsWith('/calendar')) {
			invalidateAll();
		}
	}

	async function poll() {
		if (polling) return;
		// Cross-tab gate: with several tabs open, only the one whose timer
		// fires first actually polls each window — the rest see the fresh
		// timestamp and skip. Cuts server load by the tab count and stops
		// duplicate desktop notifications (system notifications from the
		// polling tab reach the user regardless of which tab is focused).
		const lastPoll = readJson<number>(LAST_POLL_KEY, 0);
		if (Date.now() - lastPoll < POLL_INTERVAL_MS * 0.9) return;
		writeJson(LAST_POLL_KEY, Date.now());
		polling = true;
		try {
			const tokens = readJson<Record<string, string>>(TOKENS_KEY, {});
			const res = await fetch('/api/calendar/poll', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ tokens })
			});
			if (!res.ok) return;
			const data = (await res.json()) as {
				tokens: Record<string, string>;
				changed: ChangedEvent[];
				reminders: ReminderItem[];
			};
			if (data.tokens) writeJson(TOKENS_KEY, data.tokens);
			if (data.changed?.length) notifyChanged(data.changed);
			scheduleReminders(data.reminders ?? []);
		} catch {
			// Network hiccup — next interval retries.
		} finally {
			polling = false;
		}
	}

	return {
		start(opts: CalendarNotifyOptions) {
			if (!browser) return;
			options = opts;
			if (timer) return;
			void poll();
			timer = setInterval(() => void poll(), POLL_INTERVAL_MS);
		},
		setOptions(opts: CalendarNotifyOptions) {
			options = opts;
			if (!opts.reminders) clearReminderTimers();
		},
		stop() {
			if (timer) {
				clearInterval(timer);
				timer = null;
			}
			clearReminderTimers();
		}
	};
}

export const calendarNotify = createCalendarNotify();
