import { XMLParser } from 'fast-xml-parser';
import type { AuthState } from '$lib/jmap/types';

/**
 * Minimal CalDAV client for Stalwart. Stalwart serves calendars at
 * `/dav/cal/{account}/{calendar}/` next to the JMAP base we already
 * authenticate against, with the same Basic credentials.
 *
 * Only the verbs the calendar UI needs are implemented: collection listing
 * (PROPFIND), calendar CRUD (MKCALENDAR / PROPPATCH / DELETE), ranged event
 * queries (REPORT calendar-query), change detection (REPORT
 * sync-collection, RFC 6578) and object CRUD (GET / PUT / DELETE).
 */

export class CalDAVError extends Error {
	constructor(
		message: string,
		public status: number
	) {
		super(message);
		this.name = 'CalDAVError';
	}
}

export interface DavCalendar {
	/** Decoded collection name — last href segment. */
	id: string;
	/** Server-relative href, percent-encoded as the server returned it. */
	href: string;
	name: string;
	ctag: string | null;
}

export interface DavObject {
	href: string;
	etag: string | null;
	ics: string;
}

export interface SyncResult {
	token: string | null;
	/** Hrefs that were created or modified since the previous token. */
	changed: { href: string; etag: string | null }[];
	/** Hrefs removed since the previous token. */
	removed: string[];
	/** True when the provided token was rejected and a full resync happened. */
	reset: boolean;
}

const parser = new XMLParser({
	removeNSPrefix: true,
	ignoreAttributes: false,
	attributeNamePrefix: '@_',
	// Keep text content as strings — etags/ctags can look numeric.
	parseTagValue: false,
	isArray: (name) => name === 'response' || name === 'propstat'
});

/** Server origin, e.g. https://mx.example.com — apiUrl minus the /jmap/ suffix. */
export function davOrigin(auth: AuthState): string {
	return auth.apiUrl.replace(/\/jmap\/?$/, '');
}

// Per-account calendar-home override, populated by discovery (RFC 6764) when
// the constructed path doesn't answer. Keyed by email — accounts are unique
// by email, and this stays a process-local cache (discovery is one cheap
// PROPFIND on first calendar use, then free).
const homeOverride = new Map<string, string>();

/** The conventional Stalwart calendar home — the discovery fallback. */
function constructedHome(userEmail: string): string {
	return `/dav/cal/${encodeURIComponent(userEmail)}/`;
}

/** Calendar home collection for the account, server-relative. */
export function calendarHomeHref(userEmail: string): string {
	return homeOverride.get(userEmail) ?? constructedHome(userEmail);
}

export function calendarHref(userEmail: string, calendarId: string): string {
	return `${calendarHomeHref(userEmail)}${encodeURIComponent(calendarId)}/`;
}

// Read verbs are safe to retry once on transient trouble (5xx, 429, network
// blip) — a single retry absorbs most intermittent "couldn't reach the
// calendar server" banners without masking real outages. Writes are never
// retried here: their conditional headers make duplicates harmless, but a
// retry could double-apply against a different etag.
const RETRYABLE_METHODS = new Set(['GET', 'PROPFIND', 'REPORT']);

async function davRequest(
	auth: AuthState,
	method: string,
	href: string,
	options: { body?: string; headers?: Record<string, string> } = {}
): Promise<Response> {
	const doFetch = () =>
		fetch(`${davOrigin(auth)}${href}`, {
			method,
			headers: {
				Authorization: auth.authHeader,
				...options.headers
			},
			body: options.body
		});

	try {
		const res = await doFetch();
		if (RETRYABLE_METHODS.has(method) && (res.status >= 500 || res.status === 429)) {
			await new Promise((r) => setTimeout(r, 300));
			return doFetch();
		}
		return res;
	} catch (err) {
		if (!RETRYABLE_METHODS.has(method)) throw err;
		await new Promise((r) => setTimeout(r, 300));
		return doFetch();
	}
}

interface PropstatProps {
	[key: string]: unknown;
}

interface ParsedResponse {
	href: string;
	props: PropstatProps;
	status: string | null;
}

/** Flatten a multistatus into per-href props (200-status propstats only). */
function parseMultistatus(xml: string): { responses: ParsedResponse[]; syncToken: string | null } {
	const doc = parser.parse(xml);
	const ms = doc?.multistatus;
	if (!ms) return { responses: [], syncToken: null };

	const responses: ParsedResponse[] = [];
	for (const r of (ms.response ?? []) as Array<Record<string, unknown>>) {
		const href = typeof r.href === 'string' ? r.href : String(r.href ?? '');
		const props: PropstatProps = {};
		let status: string | null = typeof r.status === 'string' ? r.status : null;
		for (const ps of (r.propstat ?? []) as Array<Record<string, unknown>>) {
			const psStatus = typeof ps.status === 'string' ? ps.status : '';
			if (psStatus && !psStatus.includes('200')) continue;
			Object.assign(props, ps.prop ?? {});
		}
		responses.push({ href, props, status });
	}
	const syncToken = typeof ms['sync-token'] === 'string' ? ms['sync-token'] : null;
	return { responses, syncToken };
}

function textProp(props: PropstatProps, key: string): string | null {
	const v = props[key];
	if (typeof v === 'string') return v;
	if (typeof v === 'number') return String(v);
	// Self-closing / empty elements parse to '' or {}.
	return null;
}

function decodedLastSegment(href: string): string {
	const trimmed = href.replace(/\/+$/, '');
	const seg = trimmed.split('/').pop() ?? '';
	try {
		return decodeURIComponent(seg);
	} catch {
		return seg;
	}
}

/** True when two server-relative hrefs identify the same resource. */
export function hrefsEqual(a: string, b: string): boolean {
	const norm = (h: string) => {
		try {
			return decodeURIComponent(h).replace(/\/+$/, '');
		} catch {
			return h.replace(/\/+$/, '');
		}
	};
	return norm(a) === norm(b);
}

/** Pull a single `<d:href>` out of a parsed prop value, array-tolerant. */
function hrefFromProp(value: unknown): string | null {
	if (!value || typeof value !== 'object') return null;
	const href = (value as Record<string, unknown>).href;
	if (typeof href === 'string') return href;
	if (Array.isArray(href) && typeof href[0] === 'string') return href[0];
	return null;
}

async function propfindResponses(
	auth: AuthState,
	href: string,
	innerProps: string
): Promise<ParsedResponse[]> {
	const body = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>${innerProps}</d:prop>
</d:propfind>`;
	const res = await davRequest(auth, 'PROPFIND', href, {
		body,
		headers: { Depth: '0', 'Content-Type': 'application/xml; charset=utf-8' }
	});
	if (!res.ok && res.status !== 207) {
		throw new CalDAVError(`PROPFIND ${href} failed: ${res.status}`, res.status);
	}
	return parseMultistatus(await res.text()).responses;
}

/**
 * RFC 6764 calendar-home discovery: current-user-principal → calendar-home-set.
 * Best-effort; returns null on any hiccup so the caller keeps the constructed
 * path. Tries the DAV root, the well-known alias, then the server root.
 */
async function discoverCalendarHome(auth: AuthState): Promise<string | null> {
	let principal: string | null = null;
	for (const start of ['/dav/', '/.well-known/caldav', '/']) {
		try {
			for (const r of await propfindResponses(auth, start, '<d:current-user-principal/>')) {
				const h = hrefFromProp(r.props['current-user-principal']);
				if (h) {
					principal = h;
					break;
				}
			}
		} catch {
			// try the next candidate root
		}
		if (principal) break;
	}
	if (!principal) return null;

	try {
		for (const r of await propfindResponses(auth, principal, '<c:calendar-home-set/>')) {
			const h = hrefFromProp(r.props['calendar-home-set']);
			if (h) return h.endsWith('/') ? h : `${h}/`;
		}
	} catch {
		// fall through to null
	}
	return null;
}

/**
 * Resolve (and cache) the account's calendar home. The constructed Stalwart
 * path is probed first; only if it doesn't answer as a collection do we fall
 * back to RFC 6764 discovery. Working deployments keep their exact behavior
 * (one extra depth-0 PROPFIND on first use); misconfigured principal paths —
 * e.g. a login name that differs from the email — get a self-healing path.
 */
export async function resolveCalendarHome(auth: AuthState, userEmail: string): Promise<string> {
	const cached = homeOverride.get(userEmail);
	if (cached) return cached;

	const constructed = constructedHome(userEmail);
	try {
		const res = await davRequest(auth, 'PROPFIND', constructed, {
			body: `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>`,
			headers: { Depth: '0', 'Content-Type': 'application/xml; charset=utf-8' }
		});
		if (res.status === 207) {
			homeOverride.set(userEmail, constructed);
			return constructed;
		}
		// 404/403 here = the conventional path isn't this server's home.
	} catch {
		// Network/parse trouble — discovery may still succeed.
	}

	const discovered = await discoverCalendarHome(auth);
	const home = discovered ?? constructed;
	homeOverride.set(userEmail, home);
	return home;
}

export async function listCalendars(auth: AuthState, userEmail: string): Promise<DavCalendar[]> {
	const body = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/">
  <d:prop>
    <d:displayname/>
    <d:resourcetype/>
    <cs:getctag/>
  </d:prop>
</d:propfind>`;

	const home = calendarHomeHref(userEmail);
	const res = await davRequest(auth, 'PROPFIND', home, {
		body,
		headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' }
	});
	if (res.status === 404) return [];
	if (!res.ok && res.status !== 207) {
		throw new CalDAVError(`PROPFIND ${home} failed: ${res.status}`, res.status);
	}

	const { responses } = parseMultistatus(await res.text());
	const calendars: DavCalendar[] = [];
	for (const r of responses) {
		if (hrefsEqual(r.href, home)) continue;
		const rt = r.props['resourcetype'];
		const isCalendar =
			!!rt && typeof rt === 'object' && 'calendar' in (rt as Record<string, unknown>);
		if (!isCalendar) continue;
		const id = decodedLastSegment(r.href);
		calendars.push({
			id,
			href: r.href.endsWith('/') ? r.href : `${r.href}/`,
			name: textProp(r.props, 'displayname') || id,
			ctag: textProp(r.props, 'getctag')
		});
	}
	return calendars;
}

export async function createCalendar(
	auth: AuthState,
	userEmail: string,
	calendarId: string,
	displayName: string
): Promise<void> {
	const body = `<?xml version="1.0" encoding="utf-8"?>
<c:mkcalendar xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:set>
    <d:prop>
      <d:displayname>${escapeXml(displayName)}</d:displayname>
    </d:prop>
  </d:set>
</c:mkcalendar>`;
	const res = await davRequest(auth, 'MKCALENDAR', calendarHref(userEmail, calendarId), {
		body,
		headers: { 'Content-Type': 'application/xml; charset=utf-8' }
	});
	if (!res.ok) {
		throw new CalDAVError(`MKCALENDAR failed: ${res.status}`, res.status);
	}
}

export async function renameCalendar(
	auth: AuthState,
	userEmail: string,
	calendarId: string,
	displayName: string
): Promise<void> {
	const body = `<?xml version="1.0" encoding="utf-8"?>
<d:propertyupdate xmlns:d="DAV:">
  <d:set>
    <d:prop>
      <d:displayname>${escapeXml(displayName)}</d:displayname>
    </d:prop>
  </d:set>
</d:propertyupdate>`;
	const res = await davRequest(auth, 'PROPPATCH', calendarHref(userEmail, calendarId), {
		body,
		headers: { 'Content-Type': 'application/xml; charset=utf-8' }
	});
	if (!res.ok && res.status !== 207) {
		throw new CalDAVError(`PROPPATCH failed: ${res.status}`, res.status);
	}
}

export async function deleteCalendar(
	auth: AuthState,
	userEmail: string,
	calendarId: string
): Promise<void> {
	const res = await davRequest(auth, 'DELETE', calendarHref(userEmail, calendarId));
	if (!res.ok && res.status !== 204) {
		throw new CalDAVError(`DELETE calendar failed: ${res.status}`, res.status);
	}
}

/** ICS date-time in the `YYYYMMDDTHHMMSSZ` form CalDAV time-range filters expect. */
function toIcsUtc(ms: number): string {
	return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/**
 * All VEVENT objects overlapping [startUtcMs, endUtcMs). The server handles
 * recurrence overlap per RFC 4791 §9.9 — masters that recur into the range
 * are returned whole.
 */
export async function queryEvents(
	auth: AuthState,
	calHref: string,
	startUtcMs: number,
	endUtcMs: number
): Promise<DavObject[]> {
	const body = `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:getetag/>
    <c:calendar-data/>
  </d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VEVENT">
        <c:time-range start="${toIcsUtc(startUtcMs)}" end="${toIcsUtc(endUtcMs)}"/>
      </c:comp-filter>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`;

	const res = await davRequest(auth, 'REPORT', calHref, {
		body,
		headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' }
	});
	if (!res.ok && res.status !== 207) {
		throw new CalDAVError(`REPORT calendar-query failed: ${res.status}`, res.status);
	}

	const { responses } = parseMultistatus(await res.text());
	const objects: DavObject[] = [];
	for (const r of responses) {
		const ics = textProp(r.props, 'calendar-data');
		if (!ics) continue;
		objects.push({ href: r.href, etag: textProp(r.props, 'getetag'), ics });
	}
	return objects;
}

/** Incremental change feed for one calendar collection (RFC 6578). */
export async function syncCollection(
	auth: AuthState,
	calHref: string,
	token: string | null
): Promise<SyncResult> {
	const body = `<?xml version="1.0" encoding="utf-8"?>
<d:sync-collection xmlns:d="DAV:">
  <d:sync-token>${token ? escapeXml(token) : ''}</d:sync-token>
  <d:sync-level>1</d:sync-level>
  <d:prop><d:getetag/></d:prop>
</d:sync-collection>`;

	const res = await davRequest(auth, 'REPORT', calHref, {
		body,
		headers: { Depth: '0', 'Content-Type': 'application/xml; charset=utf-8' }
	});

	// An expired/unknown token gets 403/409/412 — restart with a clean slate.
	if (token && (res.status === 403 || res.status === 409 || res.status === 412)) {
		const fresh = await syncCollection(auth, calHref, null);
		return { ...fresh, reset: true };
	}
	if (!res.ok && res.status !== 207) {
		throw new CalDAVError(`REPORT sync-collection failed: ${res.status}`, res.status);
	}

	const { responses, syncToken } = parseMultistatus(await res.text());
	const changed: { href: string; etag: string | null }[] = [];
	const removed: string[] = [];
	for (const r of responses) {
		if (hrefsEqual(r.href, calHref)) continue;
		if (r.status && r.status.includes('404')) {
			removed.push(r.href);
		} else {
			changed.push({ href: r.href, etag: textProp(r.props, 'getetag') });
		}
	}
	return { token: syncToken, changed, removed, reset: false };
}

export async function getObject(auth: AuthState, href: string): Promise<DavObject> {
	const res = await davRequest(auth, 'GET', href, {
		headers: { Accept: 'text/calendar' }
	});
	if (!res.ok) {
		throw new CalDAVError(`GET ${href} failed: ${res.status}`, res.status);
	}
	return { href, etag: res.headers.get('ETag'), ics: await res.text() };
}

export async function putObject(
	auth: AuthState,
	href: string,
	ics: string,
	etag?: string | null
): Promise<void> {
	const headers: Record<string, string> = { 'Content-Type': 'text/calendar; charset=utf-8' };
	// Lost-update protection: a string etag means "update only" (If-Match),
	// null means "create only" (If-None-Match: *), undefined writes
	// unconditionally (invitation imports overwrite by design).
	if (etag) headers['If-Match'] = etag;
	else if (etag === null) headers['If-None-Match'] = '*';

	const res = await davRequest(auth, 'PUT', href, { body: ics, headers });
	if (!res.ok) {
		throw new CalDAVError(`PUT ${href} failed: ${res.status}`, res.status);
	}
}

export async function deleteObject(auth: AuthState, href: string, etag?: string | null): Promise<void> {
	// With an etag the delete is conditional (If-Match): an object that changed
	// on another device since it was read stays, and the caller hears 412.
	const res = await davRequest(auth, 'DELETE', href, etag ? { headers: { 'If-Match': etag } } : {});
	if (!res.ok && res.status !== 204 && res.status !== 404) {
		throw new CalDAVError(`DELETE ${href} failed: ${res.status}`, res.status);
	}
}

function escapeXml(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

/** Opaque, URL-safe object id for client round-trips. */
export function hrefToId(href: string): string {
	return Buffer.from(href, 'utf8').toString('base64url');
}

/**
 * A calendar collection id as it may appear in a URL: one path segment. `.`
 * and `..` (and their `%2e` spellings, which SvelteKit decodes before the
 * route sees them) would send the request to the calendar home's parent.
 */
export function isCollectionId(id: string): boolean {
	return id.length > 0 && id.length <= 255 && id !== '.' && id !== '..' && !/[/\\\u0000-\u001f]/.test(id);
}

/**
 * Decode an object id back to an href, verifying it stays inside the user's
 * calendar home so a forged id can't reach other accounts' collections.
 *
 * Checked against the path fetch will actually request: the WHATWG parser
 * resolves `..` and its `%2e%2e` spelling, so an href passes only when that
 * resolution changes nothing and the result still starts with the home.
 */
export function idToHref(id: string, userEmail: string): string | null {
	let href: string;
	try {
		href = Buffer.from(id, 'base64url').toString('utf8');
	} catch {
		return null;
	}
	if (!href.startsWith('/')) return null;
	try {
		const resolved = new URL(href, 'http://caldav.invalid');
		if (resolved.search || resolved.hash) return null;
		const decoded = decodeURIComponent(href);
		if (decodeURIComponent(resolved.pathname) !== decoded) return null;
		if (decoded.split('/').some((segment) => segment === '.' || segment === '..')) return null;
		if (!decoded.startsWith(decodeURIComponent(calendarHomeHref(userEmail)))) return null;
	} catch {
		return null;
	}
	return href;
}

/** The calendar collection id an object href belongs to. */
export function calendarIdFromHref(href: string, userEmail: string): string | null {
	let decoded: string;
	try {
		decoded = decodeURIComponent(href);
	} catch {
		return null;
	}
	const home = decodeURIComponent(calendarHomeHref(userEmail));
	if (!decoded.startsWith(home)) return null;
	const rest = decoded.slice(home.length);
	const seg = rest.split('/')[0];
	return seg || null;
}
