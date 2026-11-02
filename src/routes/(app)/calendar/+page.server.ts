import type { PageServerLoad } from './$types';
import { redirect } from '@sveltejs/kit';
import { getEventsInRange } from '$lib/server/calendar/service';
import { userEmailFromAuth } from '$lib/server/user';
import { isCalendarView, type CalendarInfo, type CalendarView, type EventInstance } from '$lib/calendar/types';
import { readPreferences } from '$lib/server/preferences';
import { isValidTimeZone } from '$lib/server/calendar/tz';

export type { CalendarView };

const DAY_MS = 86400000;

/** The cookie the browser leaves with its IANA zone, so "today" is the user's day and not the server's. */
const TIME_ZONE_COOKIE = 'calendar_tz';

/** Today's `YYYY-MM-DD` in `zone`; UTC when the zone is missing or unknown. */
function todayIn(zone: string | undefined): string {
	const timeZone = zone && zone.length <= 64 && isValidTimeZone(zone) ? zone : 'UTC';
	// The Swedish locale's default date form is ISO.
	return new Intl.DateTimeFormat('sv', { timeZone }).format(new Date());
}

export const load: PageServerLoad = async ({ locals, url, cookies }) => {
	if (!locals.auth) redirect(303, '/login');

	const prefs = locals.user ? readPreferences(locals.user.id, cookies) : {};
	// The URL's view, or else the one last chosen (so the rail's plain
	// /calendar link opens it), or else Month.
	const viewParam = url.searchParams.get('view');
	const view: CalendarView = isCalendarView(viewParam)
		? viewParam
		: isCalendarView(prefs.calendar_view)
			? prefs.calendar_view
			: 'month';

	const dateParam = url.searchParams.get('date');
	const dateFromUrl = !!dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam) && !isNaN(Date.parse(dateParam));
	// No date in the URL (the rail's plain /calendar link, a notification):
	// "today" is the user's, not the server's. The browser leaves its zone in
	// a cookie on its first visit; before that the UTC date stands, and the
	// page corrects itself client-side when that differs from the local day.
	const date = dateFromUrl ? (dateParam as string) : todayIn(cookies.get(TIME_ZONE_COOKIE));

	const [y, m, d] = date.split('-').map(Number);
	const anchor = Date.UTC(y, m - 1, d);

	// Generous UTC padding: month grids show up to 6 leading / 14 trailing
	// days, and local-day bucketing can shift events ±1 day vs UTC.
	let rangeStart: number;
	let rangeEnd: number;
	if (view === 'month') {
		const monthStart = Date.UTC(y, m - 1, 1);
		const monthEnd = Date.UTC(y, m, 1);
		rangeStart = monthStart - 8 * DAY_MS;
		rangeEnd = monthEnd + 15 * DAY_MS;
	} else if (view === 'week' || view === 'workweek') {
		rangeStart = anchor - 8 * DAY_MS;
		rangeEnd = anchor + 9 * DAY_MS;
	} else if (view === '3day') {
		rangeStart = anchor - 2 * DAY_MS;
		rangeEnd = anchor + 5 * DAY_MS;
	} else {
		rangeStart = anchor - 2 * DAY_MS;
		rangeEnd = anchor + 2 * DAY_MS;
	}

	const weekStartCookie = prefs.calendar_week_start;
	const weekStart = weekStartCookie === '0' ? 0 : weekStartCookie === '6' ? 6 : 1;

	const userEmail = userEmailFromAuth(locals.auth);
	let calendars: CalendarInfo[] = [];
	let events: EventInstance[] = [];
	let calendarError = false;
	let calendarErrorDetail: string | undefined;
	try {
		const result = await getEventsInRange(locals.auth, userEmail, rangeStart, rangeEnd);
		calendars = result.calendars;
		events = result.events;
		calendarError = result.partial;
		calendarErrorDetail = result.errorDetail;
	} catch (err) {
		console.warn('[calendar] load failed', err);
		calendarError = true;
		calendarErrorDetail = err instanceof Error ? err.message : String(err);
	}

	return { calendars, events, view, date, dateFromUrl, weekStart, calendarError, calendarErrorDetail };
};
