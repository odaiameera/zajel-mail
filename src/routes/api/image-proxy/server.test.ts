import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ safeFetchResponse: vi.fn() }));
vi.mock('$lib/server/avatars/net', () => ({ safeFetchResponse: mocks.safeFetchResponse }));

import { GET } from './+server';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

function call(target: string | null, signedIn = true) {
	const url = new URL('https://mail.example.test/api/image-proxy');
	if (target !== null) url.searchParams.set('url', target);
	return GET({
		url,
		locals: signedIn ? { user: { id: 'u1' } } : {}
	} as unknown as Parameters<typeof GET>[0]) as Promise<Response>;
}

/** An upstream answer whose body arrives in the given pieces. */
function upstream(
	chunks: Uint8Array[],
	init: { status?: number; headers?: Record<string, string>; onCancel?: () => void } = {}
): Response {
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			const next = chunks.shift();
			if (next) controller.enqueue(next);
			else controller.close();
		},
		cancel() {
			init.onCancel?.();
		}
	});
	return new Response(body, { status: init.status ?? 200, headers: init.headers });
}

const bytesOf = async (res: Response) => Buffer.from(await res.arrayBuffer());

beforeEach(() => {
	mocks.safeFetchResponse.mockReset();
});

describe('GET /api/image-proxy', () => {
	it('requires a signed-in session', async () => {
		expect((await call('https://a.test/x.png', false)).status).toBe(401);
		expect(mocks.safeFetchResponse).not.toHaveBeenCalled();
	});

	it('rejects anything but an http(s) URL', async () => {
		for (const bad of [null, 'not a url', 'file:///etc/passwd', 'javascript:alert(1)']) {
			expect((await call(bad)).status).toBe(400);
		}
		expect(mocks.safeFetchResponse).not.toHaveBeenCalled();
	});

	it('serves an image with the sniffed type, not the upstream one', async () => {
		mocks.safeFetchResponse.mockResolvedValue(upstream([PNG], { headers: { 'content-type': 'text/html' } }));
		const res = await call('http://media.licdn.com/logo');
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('image/png');
		expect(res.headers.get('content-security-policy')).toContain('sandbox');
		expect(res.headers.get('x-content-type-options')).toBe('nosniff');
		expect(await bytesOf(res)).toEqual(PNG);
		expect(mocks.safeFetchResponse).toHaveBeenCalledWith(
			'http://media.licdn.com/logo',
			expect.objectContaining({ allowHttp: true, timeoutMs: 10_000 })
		);
	});

	it('passes the body on as it arrives, whole', async () => {
		const rest = [Buffer.alloc(3000, 1), Buffer.alloc(3000, 2), Buffer.alloc(10, 3)];
		mocks.safeFetchResponse.mockResolvedValue(upstream([PNG, ...rest]));
		const res = await call('https://a.test/big.png');
		expect(res.status).toBe(200);
		expect(await bytesOf(res)).toEqual(Buffer.concat([PNG, ...rest]));
	});

	it('refuses a body that is not an image', async () => {
		mocks.safeFetchResponse.mockResolvedValue(
			upstream([Buffer.from('<html><script>alert(1)</script></html>')], { headers: { 'content-type': 'image/png' } })
		);
		expect((await call('https://a.test/x.png')).status).toBe(415);
	});

	it('lets a long non-image upstream go once the first kilobyte has told it enough', async () => {
		const onCancel = vi.fn();
		// Longer than the sniff window, so the stream is still open when it is refused.
		const page = Buffer.from('<html><script>alert(1)</script>' + 'x'.repeat(4000) + '</html>');
		mocks.safeFetchResponse.mockResolvedValue(
			upstream([page.subarray(0, 1500), page.subarray(1500)], { headers: { 'content-type': 'image/png' }, onCancel })
		);
		expect((await call('https://a.test/x.png')).status).toBe(415);
		expect(onCancel).toHaveBeenCalled();
	});

	it('cuts the stream past the cap instead of holding it, and cancels upstream', async () => {
		const onCancel = vi.fn();
		const megabyte = Buffer.alloc(1024 * 1024, 7);
		mocks.safeFetchResponse.mockResolvedValue(
			upstream([PNG, megabyte, megabyte, megabyte, megabyte, megabyte, megabyte], { onCancel })
		);
		const res = await call('https://a.test/huge.png');
		// Headers are already out when the cap is passed; the body is what fails.
		expect(res.status).toBe(200);
		await expect(res.arrayBuffer()).rejects.toThrow(/size limit/);
		expect(onCancel).toHaveBeenCalled();
	});

	it('turns away an image that declares itself too big before reading it', async () => {
		const onCancel = vi.fn();
		mocks.safeFetchResponse.mockResolvedValue(
			upstream([PNG], { headers: { 'content-length': String(6 * 1024 * 1024) }, onCancel })
		);
		const res = await call('https://a.test/declared.png');
		expect(res.status).toBe(502);
		expect(onCancel).toHaveBeenCalled();
	});

	it('fetches a few at a time, queues the next few and turns the rest away', async () => {
		// Every upstream fetch hangs until released, so the gate is what answers.
		let finish: (() => void) | null = null;
		const gate = new Promise<void>((resolve) => { finish = resolve; });
		mocks.safeFetchResponse.mockImplementation(async () => {
			await gate;
			return upstream([PNG]);
		});

		const IN_FLIGHT = 8;
		const WAITING = 32;
		// A slot is held until the body has been streamed, so each caller reads it.
		const pending = Array.from({ length: IN_FLIGHT + WAITING }, (_, i) =>
			call(`https://a.test/${i}.png`).then(async (res) => {
				if (res.status === 200) await res.arrayBuffer();
				return res;
			})
		);
		// Let the first wave reach the fetch.
		await new Promise((r) => setTimeout(r, 0));
		expect(mocks.safeFetchResponse).toHaveBeenCalledTimes(IN_FLIGHT);

		const refused = await call('https://a.test/one-too-many.png');
		expect(refused.status).toBe(503);
		expect(refused.headers.get('retry-after')).toBe('2');
		expect(refused.headers.get('cache-control')).toBe('no-store');
		expect(mocks.safeFetchResponse).toHaveBeenCalledTimes(IN_FLIGHT);

		finish!();
		const done = await Promise.all(pending);
		expect(done.every((r) => r.status === 200)).toBe(true);
		expect(mocks.safeFetchResponse).toHaveBeenCalledTimes(IN_FLIGHT + WAITING);

		// The gate is open again afterwards.
		mocks.safeFetchResponse.mockImplementation(async () => upstream([PNG]));
		expect((await call('https://a.test/after.png')).status).toBe(200);
	});

	it('reports upstream failures without caching them', async () => {
		mocks.safeFetchResponse.mockResolvedValue(null); // blocked host, timeout
		const blocked = await call('https://10.0.0.1/x.png');
		expect(blocked.status).toBe(502);
		expect(blocked.headers.get('cache-control')).toBe('no-store');

		mocks.safeFetchResponse.mockResolvedValue(upstream([PNG], { status: 404 }));
		expect((await call('https://a.test/gone.png')).status).toBe(502);
	});
});
