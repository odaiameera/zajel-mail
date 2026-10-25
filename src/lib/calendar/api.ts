import type { EditScope, EventWritePayload } from './types';

/**
 * Thin client for the calendar API. Mutations record the touched object ids
 * in localStorage so the notification poller can tell our own edits apart
 * from changes made on other devices (which *should* notify).
 */

const TOUCHED_KEY = 'cal-touched-v1';
const TOUCH_TTL_MS = 5 * 60 * 1000;

function readTouched(): Record<string, number> {
	try {
		const raw = localStorage.getItem(TOUCHED_KEY);
		return raw ? (JSON.parse(raw) as Record<string, number>) : {};
	} catch {
		return {};
	}
}

export function markTouched(id: string): void {
	try {
		const map = readTouched();
		const now = Date.now();
		for (const [k, ts] of Object.entries(map)) {
			if (now - ts > TOUCH_TTL_MS) delete map[k];
		}
		map[id] = now;
		localStorage.setItem(TOUCHED_KEY, JSON.stringify(map));
	} catch {
		// Best-effort.
	}
}

export function wasTouchedRecently(id: string): boolean {
	const ts = readTouched()[id];
	return !!ts && Date.now() - ts < TOUCH_TTL_MS;
}

export interface ApiResult {
	ok: boolean;
	error?: string;
	id?: string;
}

async function jsonFetch(url: string, init: RequestInit): Promise<ApiResult> {
	try {
		const res = await fetch(url, {
			headers: { 'Content-Type': 'application/json' },
			...init
		});
		const data = (await res.json().catch(() => ({}))) as { error?: string; id?: string };
		if (!res.ok) return { ok: false, error: data?.error ?? `HTTP ${res.status}` };
		return { ok: true, id: data?.id };
	} catch {
		return { ok: false, error: 'Network error' };
	}
}

export async function apiCreateEvent(payload: EventWritePayload): Promise<ApiResult> {
	const res = await jsonFetch('/api/calendar/events', {
		method: 'POST',
		body: JSON.stringify(payload)
	});
	if (res.ok && res.id) markTouched(res.id);
	return res;
}

export async function apiUpdateEvent(
	id: string,
	payload: EventWritePayload,
	scope: EditScope,
	recurrenceId: string | null
): Promise<ApiResult> {
	markTouched(id);
	const res = await jsonFetch(`/api/calendar/events/${encodeURIComponent(id)}`, {
		method: 'PATCH',
		body: JSON.stringify({ event: payload, scope, recurrenceId })
	});
	if (res.ok && res.id) markTouched(res.id);
	return res;
}

export async function apiDeleteEvent(
	id: string,
	scope: EditScope,
	recurrenceId: string | null
): Promise<ApiResult> {
	markTouched(id);
	const params = new URLSearchParams({ scope });
	if (recurrenceId) params.set('recurrenceId', recurrenceId);
	return jsonFetch(`/api/calendar/events/${encodeURIComponent(id)}?${params}`, {
		method: 'DELETE'
	});
}

export interface ImportBatchResult {
	imported: number;
	failed: number;
	firstDay: string | null;
}

export async function apiImportEvents(calendarId: string, ics: string): Promise<ImportBatchResult> {
	let res: Response;
	try {
		res = await fetch('/api/calendar/import', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ calendarId, ics })
		});
	} catch {
		throw new Error('Network error');
	}
	const data = (await res.json().catch(() => ({}))) as Partial<ImportBatchResult> & { error?: string };
	if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
	return { imported: data.imported ?? 0, failed: data.failed ?? 0, firstDay: data.firstDay ?? null };
}

export async function apiCreateCalendar(name: string, color: string): Promise<ApiResult> {
	return jsonFetch('/api/calendar/calendars', {
		method: 'POST',
		body: JSON.stringify({ name, color })
	});
}

export async function apiUpdateCalendar(
	id: string,
	patch: { name?: string; color?: string; hidden?: boolean }
): Promise<ApiResult> {
	return jsonFetch(`/api/calendar/calendars/${encodeURIComponent(id)}`, {
		method: 'PATCH',
		body: JSON.stringify(patch)
	});
}

export async function apiDeleteCalendar(id: string): Promise<ApiResult> {
	return jsonFetch(`/api/calendar/calendars/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
