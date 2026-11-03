import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getAvatar: vi.fn() }));
vi.mock('$lib/server/avatars', () => ({ getAvatar: mocks.getAvatar }));

import { GET } from './+server';

const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

function call(email: string | null, signedIn = true, headers: Record<string, string> = {}) {
	const url = new URL('https://mail.example.test/api/avatar');
	if (email !== null) url.searchParams.set('email', email);
	return GET({
		url,
		locals: signedIn ? { user: { id: 'u1' } } : {},
		request: new Request(url, { headers })
	} as unknown as Parameters<typeof GET>[0]) as Promise<Response>;
}

beforeEach(() => {
	mocks.getAvatar.mockReset();
});

describe('GET /api/avatar', () => {
	it('is for signed-in sessions asking about an address', async () => {
		expect((await call('a@b.test', false)).status).toBe(401);
		expect((await call(null)).status).toBe(400);
		expect((await call('not-an-address')).status).toBe(400);
		expect(mocks.getAvatar).not.toHaveBeenCalled();
	});

	it('answers "no avatar" with an uncached 204', async () => {
		mocks.getAvatar.mockResolvedValue({ status: 'missing' });
		const res = await call('a@b.test');
		expect(res.status).toBe(204);
		expect(res.headers.get('cache-control')).toBe('no-store');
	});

	it('serves a found logo sandboxed, with an ETag the browser can revalidate', async () => {
		mocks.getAvatar.mockResolvedValue({ status: 'found', contentType: 'image/svg+xml', bytes: SVG, source: 'bimi' });
		const res = await call('a@brand.test');
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('image/svg+xml');
		expect(res.headers.get('content-security-policy')).toContain('sandbox');
		expect(res.headers.get('x-content-type-options')).toBe('nosniff');
		expect(res.headers.get('cache-control')).toBe('private, max-age=86400');
		const etag = res.headers.get('etag')!;
		const again = await call('a@brand.test', true, { 'if-none-match': etag });
		expect(again.status).toBe(304);
		expect(again.headers.get('content-security-policy')).toContain('sandbox');
	});
});
