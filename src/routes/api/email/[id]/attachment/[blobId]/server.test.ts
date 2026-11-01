import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GET } from './+server';

const fetchMock = vi.fn();

function call(name: string) {
	const url = new URL('https://mail.example.test/api/email/e1/attachment/b1');
	url.searchParams.set('name', name);
	return GET({
		url,
		params: { id: 'e1', blobId: 'b1' },
		locals: { auth: { apiUrl: 'https://jmap.test/', accountId: 'a1', authHeader: 'Basic x' } }
	} as unknown as Parameters<typeof GET>[0]) as Promise<Response>;
}

beforeEach(() => {
	fetchMock.mockReset().mockImplementation(
		async () =>
			new Response('PDF', { status: 200, headers: { 'Content-Type': 'application/octet-stream' } })
	);
	vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('GET /api/email/[id]/attachment/[blobId]', () => {
	it('serves names outside Latin-1 through filename*', async () => {
		for (const name of ['تقرير.pdf', '報告.xlsx', '😀.png']) {
			const res = await call(name);
			expect(res.status).toBe(200);
			const header = res.headers.get('content-disposition') ?? '';
			expect(header).toContain(`filename*=UTF-8''${encodeURIComponent(name)}`);
			expect(header).toMatch(/^attachment; filename="[\x20-\x7e]+"; /);
		}
	});

	it('keeps plain ASCII names as they are', async () => {
		const res = await call("Q3 (final) it's.pdf");
		expect(res.headers.get('content-disposition')).toBe(
			`attachment; filename="Q3 (final) it's.pdf"; filename*=UTF-8''Q3%20%28final%29%20it%27s.pdf`
		);
		expect(res.headers.get('content-type')).toBe('application/pdf');
	});

	it('drops quotes and line breaks from the name', async () => {
		const res = await call('a"b\r\nSet-Cookie: x.pdf');
		expect(res.status).toBe(200);
		const header = res.headers.get('content-disposition') ?? '';
		expect(header).not.toMatch(/[\r\n]/);
		expect(header).toContain('filename="abSet-Cookie: x.pdf"');
	});
});
