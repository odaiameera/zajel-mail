import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ safeFetch: vi.fn() }));
vi.mock('$lib/server/avatars/net', () => ({ safeFetch: mocks.safeFetch }));

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

beforeEach(() => {
	mocks.safeFetch.mockReset();
});

describe('GET /api/image-proxy', () => {
	it('requires a signed-in session', async () => {
		expect((await call('https://a.test/x.png', false)).status).toBe(401);
		expect(mocks.safeFetch).not.toHaveBeenCalled();
	});

	it('rejects anything but an http(s) URL', async () => {
		for (const bad of [null, 'not a url', 'file:///etc/passwd', 'javascript:alert(1)']) {
			expect((await call(bad)).status).toBe(400);
		}
		expect(mocks.safeFetch).not.toHaveBeenCalled();
	});

	it('serves an image with the sniffed type, not the upstream one', async () => {
		mocks.safeFetch.mockResolvedValue({ bytes: PNG, contentType: 'text/html', status: 200 });
		const res = await call('http://media.licdn.com/logo');
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('image/png');
		expect(res.headers.get('content-security-policy')).toContain('sandbox');
		expect(res.headers.get('x-content-type-options')).toBe('nosniff');
		expect(Buffer.from(await res.arrayBuffer())).toEqual(PNG);
		expect(mocks.safeFetch).toHaveBeenCalledWith(
			'http://media.licdn.com/logo',
			expect.objectContaining({ allowHttp: true })
		);
	});

	it('refuses a body that is not an image', async () => {
		mocks.safeFetch.mockResolvedValue({
			bytes: Buffer.from('<html><script>alert(1)</script></html>'),
			contentType: 'image/png',
			status: 200
		});
		expect((await call('https://a.test/x.png')).status).toBe(415);
	});

	it('fetches a few at a time, queues the next few and turns the rest away', async () => {
		// Every upstream fetch hangs until released, so the gate is what answers.
		let finish: (() => void) | null = null;
		const gate = new Promise<void>((resolve) => { finish = resolve; });
		mocks.safeFetch.mockImplementation(async () => {
			await gate;
			return { bytes: PNG, contentType: 'image/png', status: 200 };
		});

		const IN_FLIGHT = 8;
		const WAITING = 32;
		const pending = Array.from({ length: IN_FLIGHT + WAITING }, (_, i) => call(`https://a.test/${i}.png`));
		// Let the first wave reach safeFetch.
		await new Promise((r) => setTimeout(r, 0));
		expect(mocks.safeFetch).toHaveBeenCalledTimes(IN_FLIGHT);

		const refused = await call('https://a.test/one-too-many.png');
		expect(refused.status).toBe(503);
		expect(refused.headers.get('retry-after')).toBe('2');
		expect(refused.headers.get('cache-control')).toBe('no-store');
		expect(mocks.safeFetch).toHaveBeenCalledTimes(IN_FLIGHT);

		finish!();
		const done = await Promise.all(pending);
		expect(done.every((r) => r.status === 200)).toBe(true);
		expect(mocks.safeFetch).toHaveBeenCalledTimes(IN_FLIGHT + WAITING);

		// The gate is open again afterwards.
		mocks.safeFetch.mockResolvedValue({ bytes: PNG, contentType: 'image/png', status: 200 });
		expect((await call('https://a.test/after.png')).status).toBe(200);
	});

	it('caps what it will hold for one image', async () => {
		mocks.safeFetch.mockResolvedValue({ bytes: PNG, contentType: 'image/png', status: 200 });
		await call('https://a.test/x.png');
		expect(mocks.safeFetch).toHaveBeenCalledWith(
			'https://a.test/x.png',
			expect.objectContaining({ maxBytes: 5 * 1024 * 1024 })
		);
	});

	it('reports upstream failures without caching them', async () => {
		mocks.safeFetch.mockResolvedValue(null); // blocked host, timeout, too big
		const blocked = await call('https://10.0.0.1/x.png');
		expect(blocked.status).toBe(502);
		expect(blocked.headers.get('cache-control')).toBe('no-store');

		mocks.safeFetch.mockResolvedValue({ bytes: PNG, contentType: 'image/png', status: 404 });
		expect((await call('https://a.test/gone.png')).status).toBe(502);
	});
});
