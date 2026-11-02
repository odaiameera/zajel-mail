import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('$lib/jmap/auth', () => ({ createClient: () => ({ request: mocks.request }) }));

import { GET } from './+server';

const fetchMock = vi.fn();

// Each test gets its own email id: the route remembers a message's part
// types for a minute.
let emails = 0;
function call(name: string, blobId = 'b1', emailId = `e${++emails}`) {
	const url = new URL(`https://mail.example.test/api/email/${emailId}/attachment/${blobId}`);
	url.searchParams.set('name', name);
	return GET({
		url,
		params: { id: emailId, blobId },
		locals: { auth: { apiUrl: 'https://jmap.test/', accountId: 'a1', authHeader: 'Basic x' } }
	} as unknown as Parameters<typeof GET>[0]) as Promise<Response>;
}

function upstream(body: string, headers: Record<string, string>) {
	fetchMock.mockImplementation(async () => new Response(body, { status: 200, headers }));
}

/** What Email/get answers: the message's parts, by list. */
function parts(lists: Record<string, Array<{ blobId: string; type: string }>>) {
	mocks.request.mockResolvedValue({ methodResponses: [['Email/get', { list: [lists] }, '0']] });
}

beforeEach(() => {
	fetchMock.mockReset();
	upstream('PDF', { 'Content-Type': 'application/octet-stream' });
	vi.stubGlobal('fetch', fetchMock);
	mocks.request.mockReset();
	parts({});
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

	it('refuses a blob id that is not a JMAP id, before fetching anything', async () => {
		// What `..%2F..%2F..%2Fapi%2Freload%3F` arrives as once SvelteKit decodes it.
		for (const blobId of ['../../../api/reload?', 'a/b', 'x?y', '']) {
			expect((await call('a.pdf', blobId)).status).toBe(400);
		}
		expect(fetchMock).not.toHaveBeenCalled();

		await call('a.pdf', 'Gd2e3f_9-xYz');
		expect(fetchMock).toHaveBeenCalledWith(
			'https://jmap.test/download/a1/Gd2e3f_9-xYz/a.pdf',
			expect.anything()
		);
	});

	it('drops quotes and line breaks from the name', async () => {
		const res = await call('a"b\r\nSet-Cookie: x.pdf');
		expect(res.status).toBe(200);
		const header = res.headers.get('content-disposition') ?? '';
		expect(header).not.toMatch(/[\r\n]/);
		expect(header).toContain('filename="abSet-Cookie: x.pdf"');
	});

	it("types the response by the part's declared MIME type, not the name", async () => {
		// "Invoice" with no extension used to go out as octet-stream, which the
		// PDF viewer iframe downloads instead of showing.
		parts({ attachments: [{ blobId: 'b1', type: 'application/pdf' }] });
		const res = await call('Invoice');
		expect(res.headers.get('content-type')).toBe('application/pdf');
		expect(mocks.request).toHaveBeenCalledWith([
			['Email/get', expect.objectContaining({ properties: ['attachments', 'htmlBody', 'textBody'] }), '0']
		]);

		// A part in the body rather than the attachment list, and a declared
		// type that beats a wrong extension.
		parts({ htmlBody: [{ blobId: 'b1', type: 'image/jpeg' }] });
		expect((await call('photo.dat')).headers.get('content-type')).toBe('image/jpeg');
	});

	it('falls back to the extension when the part declares nothing better or cannot be looked up', async () => {
		parts({ attachments: [{ blobId: 'b1', type: 'application/octet-stream' }] });
		expect((await call('report.pdf')).headers.get('content-type')).toBe('application/pdf');

		mocks.request.mockRejectedValue(new Error('jmap down'));
		expect((await call('notes.txt')).headers.get('content-type')).toBe('text/plain; charset=utf-8');

		// Nothing to go on at all.
		mocks.request.mockRejectedValue(new Error('jmap down'));
		expect((await call('blob')).headers.get('content-type')).toBe('application/octet-stream');
	});

	it('serves what a browser would run as a document as a download instead', async () => {
		parts({ attachments: [{ blobId: 'b1', type: 'text/html' }] });
		expect((await call('page.html')).headers.get('content-type')).toBe('application/octet-stream');

		parts({});
		upstream('<html/>', { 'Content-Type': 'application/xhtml+xml' });
		expect((await call('x.xhtml')).headers.get('content-type')).toBe('application/octet-stream');

		// A declared type that is not a bare type/subtype is not trusted.
		upstream('GIF', { 'Content-Type': 'application/octet-stream' });
		parts({ attachments: [{ blobId: 'b1', type: 'image/png\r\nX-Injected: 1' }] });
		expect((await call('x.gif')).headers.get('content-type')).toBe('image/gif');
	});

	it('looks a message up once for all of its parts', async () => {
		parts({ attachments: [{ blobId: 'b1', type: 'image/png' }, { blobId: 'b2', type: 'image/gif' }] });
		expect((await call('a', 'b1', 'same')).headers.get('content-type')).toBe('image/png');
		expect((await call('b', 'b2', 'same')).headers.get('content-type')).toBe('image/gif');
		expect(mocks.request).toHaveBeenCalledTimes(1);
	});

	it('sandboxes everything it renders inline except PDFs, and forbids form posts', async () => {
		parts({ attachments: [{ blobId: 'b1', type: 'image/svg+xml' }] });
		const svg = (await call('logo.svg')).headers.get('content-security-policy') ?? '';
		expect(svg).toContain('sandbox');
		expect(svg).toContain("form-action 'none'");
		expect(svg).toContain("default-src 'none'");

		parts({ attachments: [{ blobId: 'b1', type: 'application/pdf' }] });
		const pdf = (await call('doc.pdf')).headers.get('content-security-policy') ?? '';
		expect(pdf).not.toContain('sandbox');
		expect(pdf).toContain("form-action 'none'");
	});

	it('forwards Content-Length only when upstream gives one for the bytes it sends', async () => {
		expect((await call('a.pdf')).headers.get('content-length')).toBeNull();

		upstream('PDF', { 'Content-Type': 'application/pdf', 'Content-Length': '3' });
		expect((await call('a.pdf')).headers.get('content-length')).toBe('3');

		upstream('PDF', { 'Content-Type': 'application/pdf', 'Content-Length': '3', 'Content-Encoding': 'gzip' });
		expect((await call('a.pdf')).headers.get('content-length')).toBeNull();
	});
});
