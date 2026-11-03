import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: mocks.lookup }));

import { safeFetch, safeFetchResponse, type FetchFailure } from './net';

// Public IP literals, so no test depends on DNS.
const PUBLIC = 'https://93.184.215.14';
const OTHER = 'https://93.184.215.15';

function dnsError(code: string): NodeJS.ErrnoException {
	return Object.assign(new Error(code), { code });
}

function stubFetch(...responses: Response[]) {
	const fetchMock = vi.fn(async () => responses.shift() ?? new Response('', { status: 599 }));
	vi.stubGlobal('fetch', fetchMock);
	return fetchMock;
}

/** A body that never ends on its own and fails when the request is aborted. */
function endlessBody(signal: AbortSignal | null | undefined): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.enqueue(new Uint8Array([1, 2, 3]));
			signal?.addEventListener('abort', () => controller.error(new Error('aborted')));
		}
	});
}

beforeEach(() => {
	mocks.lookup.mockImplementation(async (host: string) => {
		if (host === 'public.test') return [{ address: '93.184.215.14', family: 4 }];
		if (host === 'nowhere.test') throw dnsError('ENOTFOUND');
		throw dnsError('EAI_AGAIN');
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
	mocks.lookup.mockReset();
});

describe('safeFetch', () => {
	it('never connects to loopback, private or link-local hosts', async () => {
		const fetchMock = stubFetch();
		for (const url of [
			'https://127.0.0.1/',
			'https://10.0.0.5/',
			'https://192.168.1.1/',
			'https://169.254.169.254/latest/meta-data',
			'https://[::1]/',
			'https://[fe80::1]/',
			'https://[fe9f::1]/',
			'https://localhost/',
			'https://router.lan/'
		]) {
			expect(await safeFetch(url, { method: 'POST', body: 'x' })).toBeNull();
		}
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('sends a POST with its body and content type', async () => {
		const fetchMock = stubFetch(new Response('ok', { status: 200 }));
		const res = await safeFetch(`${PUBLIC}/u`, {
			method: 'POST',
			body: 'List-Unsubscribe=One-Click',
			contentType: 'application/x-www-form-urlencoded'
		});
		expect(res?.status).toBe(200);
		const [, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
		expect(init.method).toBe('POST');
		expect(init.body).toBe('List-Unsubscribe=One-Click');
		expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/x-www-form-urlencoded');
	});

	it('refuses a redirect into the private network', async () => {
		const fetchMock = stubFetch(
			new Response(null, { status: 307, headers: { location: 'https://127.0.0.1/admin' } })
		);
		expect(await safeFetch(`${PUBLIC}/u`, { method: 'POST', body: 'x' })).toBeNull();
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('keeps the POST across a 307/308 and drops to GET on a 303', async () => {
		const fetchMock = stubFetch(
			new Response(null, { status: 307, headers: { location: `${OTHER}/a` } }),
			new Response(null, { status: 303, headers: { location: `${OTHER}/done` } }),
			new Response('done', { status: 200 })
		);
		expect((await safeFetch(`${PUBLIC}/u`, { method: 'POST', body: 'x' }))?.status).toBe(200);
		const inits = fetchMock.mock.calls.map((c) => (c as unknown as [URL, RequestInit])[1]);
		expect(inits.map((i) => i.method)).toEqual(['POST', 'POST', 'GET']);
		expect(inits[2].body).toBeUndefined();
	});

	it('still defaults to a GET', async () => {
		const fetchMock = stubFetch(new Response('img', { status: 200 }));
		await safeFetch(`${PUBLIC}/a.png`);
		const [, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
		expect(init.method ?? 'GET').toBe('GET');
		expect(init.body).toBeUndefined();
	});

	it('counts an empty answer as a failure unless the caller expects one', async () => {
		stubFetch(new Response(null, { status: 204 }), new Response(null, { status: 204 }));
		expect(await safeFetch(`${PUBLIC}/a.png`)).toBeNull();
		const res = await safeFetch(`${PUBLIC}/u`, { method: 'POST', body: 'x', allowEmpty: true });
		expect(res?.status).toBe(204);
		expect(res?.bytes.length).toBe(0);
	});

	it('lets go of a redirect body it will never read', async () => {
		const cancelled = vi.fn();
		const hop = new Response(new ReadableStream({ cancel: cancelled }), {
			status: 302,
			headers: { location: `${OTHER}/final` }
		});
		stubFetch(hop, new Response('img', { status: 200 }));
		expect((await safeFetch(`${PUBLIC}/a.png`))?.status).toBe(200);
		expect(cancelled).toHaveBeenCalled();
	});

	// The avatar cache keeps a refusal or a missing icon for a week, but an
	// outage only for minutes, so it has to be told which one it was.
	it('says why it came back empty', async () => {
		const why = async (url: string, opts: Parameters<typeof safeFetch>[1] = {}) => {
			let reason: FetchFailure | null = null;
			await safeFetch(url, { ...opts, onFailure: (f) => { reason = f; } });
			return reason;
		};

		stubFetch();
		expect(await why('https://127.0.0.1/')).toBe('blocked');
		expect(await why('ftp://public.test/')).toBe('blocked');
		expect(await why('https://nowhere.test/')).toBe('unknown-host');
		expect(await why('https://flaky.test/')).toBe('unreachable');

		vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
		expect(await why(`${PUBLIC}/`)).toBe('unreachable');

		stubFetch(new Response(null, { status: 204 }));
		expect(await why(`${PUBLIC}/`)).toBe('empty');

		stubFetch(new Response('x', { status: 200, headers: { 'content-length': '999999' } }));
		expect(await why(`${PUBLIC}/`, { maxBytes: 10 })).toBe('too-large');

		const loop = () => new Response(null, { status: 302, headers: { location: `${OTHER}/again` } });
		stubFetch(loop(), loop(), loop(), loop(), loop(), loop());
		expect(await why(`${PUBLIC}/`)).toBe('too-many-redirects');
	});
});

describe('safeFetchResponse', () => {
	it('hands back the vetted response with its body unread', async () => {
		const fetchMock = stubFetch(
			new Response(null, { status: 301, headers: { location: `${OTHER}/img` } }),
			new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/png' } })
		);
		const res = await safeFetchResponse(`${PUBLIC}/a.png`);
		expect(res?.status).toBe(200);
		expect(res?.headers.get('content-type')).toBe('image/png');
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(Buffer.from(await res!.arrayBuffer())).toEqual(Buffer.from([1, 2, 3]));
	});

	it('refuses the same hosts and redirects as safeFetch', async () => {
		const fetchMock = stubFetch(
			new Response(null, { status: 302, headers: { location: 'https://192.168.0.1/' } })
		);
		expect(await safeFetchResponse('https://10.1.1.1/')).toBeNull();
		expect(await safeFetchResponse(`${PUBLIC}/`)).toBeNull();
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('keeps the timer armed while the body streams', async () => {
		vi.useFakeTimers();
		vi.stubGlobal(
			'fetch',
			vi.fn(async (_url: URL, init: RequestInit) => new Response(endlessBody(init.signal), { status: 200 }))
		);
		const res = await safeFetchResponse(`${PUBLIC}/slow.png`, { timeoutMs: 1000 });
		expect(res?.status).toBe(200);
		const reader = res!.body!.getReader();
		expect((await reader.read()).value).toEqual(new Uint8Array([1, 2, 3]));
		vi.advanceTimersByTime(1001);
		await expect(reader.read()).rejects.toThrow('aborted');
	});
});
