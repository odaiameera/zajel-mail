import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	getAccount: vi.fn(),
	getAccountAvatar: vi.fn(),
	getAvatar: vi.fn()
}));

vi.mock('$lib/server/auth/accounts', () => ({
	getAccount: mocks.getAccount,
	getAccountAvatar: mocks.getAccountAvatar,
	setAccountAvatar: vi.fn(),
	clearAccountAvatar: vi.fn()
}));
vi.mock('$lib/server/avatars/index', () => ({ getAvatar: mocks.getAvatar }));

import { GET } from './+server';

const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

function call(id: string, userId = 'u1', headers: Record<string, string> = {}) {
	return GET({
		params: { id },
		locals: { user: { id: userId } },
		request: new Request(`https://mail.example.test/api/accounts/${id}/avatar`, { headers })
	} as unknown as Parameters<typeof GET>[0]) as Promise<Response>;
}

beforeEach(() => {
	mocks.getAccount.mockReset();
	mocks.getAccountAvatar.mockReset();
	mocks.getAvatar.mockReset();
	mocks.getAccount.mockImplementation((id: string) =>
		id === 'acct-1' ? { id, user_id: 'u1', email: 'me@brand.test' } : undefined
	);
});

const sandboxed = (res: Response) => {
	expect(res.headers.get('content-security-policy')).toContain('sandbox');
	expect(res.headers.get('x-content-type-options')).toBe('nosniff');
	expect(res.headers.get('content-disposition')).toContain('inline');
};

describe('GET /api/accounts/[id]/avatar', () => {
	// The resolver can hand back a BIMI or favicon SVG from whoever runs the
	// mail domain, and this URL is same-origin and navigable: the same
	// headers that keep /api/avatar from running such a file as a page.
	it('sandboxes an SVG that came from the resolver', async () => {
		mocks.getAccountAvatar.mockReturnValue(null);
		mocks.getAvatar.mockResolvedValue({ status: 'found', contentType: 'image/svg+xml', bytes: SVG, source: 'bimi' });
		const res = await call('acct-1');
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('image/svg+xml');
		expect(res.headers.get('x-avatar-source')).toBe('bimi');
		sandboxed(res);
		expect(Buffer.from(await res.arrayBuffer())).toEqual(SVG);
	});

	it('sandboxes an uploaded SVG too', async () => {
		mocks.getAccountAvatar.mockReturnValue(`data:image/svg+xml;base64,${SVG.toString('base64')}`);
		const res = await call('acct-1');
		expect(res.status).toBe(200);
		expect(res.headers.get('x-avatar-source')).toBe('custom');
		sandboxed(res);
		expect(mocks.getAvatar).not.toHaveBeenCalled();
	});

	it('answers a matching ETag with a 304 that carries the same headers', async () => {
		mocks.getAccountAvatar.mockReturnValue(`data:image/png;base64,${Buffer.from('png').toString('base64')}`);
		const first = await call('acct-1');
		const etag = first.headers.get('etag')!;
		expect(first.headers.get('cache-control')).toBe('private, max-age=0, must-revalidate');
		const again = await call('acct-1', 'u1', { 'if-none-match': etag });
		expect(again.status).toBe(304);
		expect(again.headers.get('etag')).toBe(etag);
		sandboxed(again);
	});

	it('draws initials when nothing is found, and hides other users accounts', async () => {
		mocks.getAccountAvatar.mockReturnValue(null);
		mocks.getAvatar.mockResolvedValue({ status: 'missing' });
		expect((await call('acct-1')).status).toBe(404);
		await expect(call('acct-1', 'someone-else')).rejects.toMatchObject({ status: 404 });
	});
});
