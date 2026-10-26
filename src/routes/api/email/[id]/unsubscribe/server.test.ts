import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	request: vi.fn(),
	safeFetch: vi.fn(),
	sendEmail: vi.fn()
}));

vi.mock('$lib/jmap/auth', () => ({ createClient: () => ({ request: mocks.request }) }));
vi.mock('$lib/server/avatars/net', () => ({ safeFetch: mocks.safeFetch }));
vi.mock('$lib/jmap/email', () => ({ sendEmail: mocks.sendEmail }));
vi.mock('$lib/jmap/mailbox', () => ({
	getMailboxes: async () => [
		{ id: 'sent', role: 'sent' },
		{ id: 'drafts', role: 'drafts' }
	]
}));
vi.mock('$lib/server/user', () => ({ userEmailFromAuth: () => 'me@example.test' }));
vi.mock('$lib/server/identity-resolve', () => ({
	resolveIdentity: () => ({ id: 'I1', name: 'Me', email: 'me@example.test' })
}));

import { POST } from './+server';

const ONE_CLICK = {
	// Raw form, as the mail server returns it: the space after the colon and a folded line.
	'header:list-unsubscribe': ' <mailto:leave@news.test>,\r\n <https://news.test/u/abc>',
	'header:list-unsubscribe-post:asText': 'List-Unsubscribe=One-Click'
};

/** The JMAP server: Email/get answers with `headers`, Email/set succeeds. */
function mailServer(headers: Record<string, string | null> | null) {
	mocks.request.mockImplementation(async (calls: [string, Record<string, unknown>, string][]) => ({
		methodResponses: calls.map(([name, , tag]) =>
			name === 'Email/get'
				? [name, { list: headers ? [{ id: 'M1', ...headers }] : [] }, tag]
				: [name, { updated: { M1: null } }, tag]
		)
	}));
}

function call(body: unknown) {
	return POST({
		params: { id: 'M1' },
		locals: { auth: { accountId: 'A1' } },
		request: new Request('https://mail.example.test/api/email/M1/unsubscribe', {
			method: 'POST',
			body: JSON.stringify(body)
		})
	} as unknown as Parameters<typeof POST>[0]) as Promise<Response>;
}

const flagged = () =>
	mocks.request.mock.calls.some((args) =>
		(args[0] as [string][]).some(([name]) => name === 'Email/set')
	);

beforeEach(() => {
	mocks.request.mockReset();
	mocks.safeFetch.mockReset();
	mocks.sendEmail.mockReset();
});

describe('POST /api/email/[id]/unsubscribe', () => {
	it("posts one-click to the URL from the email's own header, through the SSRF guard", async () => {
		mailServer(ONE_CLICK);
		mocks.safeFetch.mockResolvedValue({ bytes: Buffer.from(''), contentType: null, status: 200 });

		const res = await call({ mode: 'one-click', url: 'https://news.test/u/abc' });

		expect(res.status).toBe(200);
		expect(mocks.safeFetch).toHaveBeenCalledWith(
			'https://news.test/u/abc',
			expect.objectContaining({ method: 'POST', body: 'List-Unsubscribe=One-Click' })
		);
		expect(flagged()).toBe(true);
	});

	it('refuses a URL the email does not list, so the endpoint cannot be aimed anywhere', async () => {
		mailServer(ONE_CLICK);
		for (const url of ['https://127.0.0.1/admin', 'https://192.168.1.1/', 'https://evil.test/']) {
			const res = await call({ mode: 'one-click', url });
			expect(res.status).toBe(400);
		}
		expect(mocks.safeFetch).not.toHaveBeenCalled();
		expect(flagged()).toBe(false);
	});

	it('refuses one-click when the email does not offer it', async () => {
		mailServer({ 'header:list-unsubscribe': ' <https://news.test/u/abc>' });
		const res = await call({ mode: 'one-click', url: 'https://news.test/u/abc' });
		expect(res.status).toBe(400);
		expect(mocks.safeFetch).not.toHaveBeenCalled();
	});

	it('reports a blocked or failed request without marking the email unsubscribed', async () => {
		// safeFetch answers null for a host that resolves to a private address.
		mailServer({
			...ONE_CLICK,
			'header:list-unsubscribe': ' <https://internal.news.test/u>'
		});
		mocks.safeFetch.mockResolvedValue(null);
		const res = await call({ mode: 'one-click', url: 'https://internal.news.test/u' });
		expect(res.status).toBe(502);
		expect(flagged()).toBe(false);
	});

	it('treats a 4xx/5xx from the sender as a failure', async () => {
		mailServer(ONE_CLICK);
		mocks.safeFetch.mockResolvedValue({ bytes: Buffer.from(''), contentType: null, status: 500 });
		expect((await call({ mode: 'one-click', url: 'https://news.test/u/abc' })).status).toBe(502);
		expect(flagged()).toBe(false);
	});

	it('only sends the unsubscribe email to the address the header names', async () => {
		mailServer({ 'header:list-unsubscribe': ' <mailto:leave@news.test?subject=stop>' });
		mocks.sendEmail.mockResolvedValue({ success: true });

		expect((await call({ mode: 'mailto', mailto: 'mailto:victim@elsewhere.test' })).status).toBe(400);
		expect(mocks.sendEmail).not.toHaveBeenCalled();

		expect((await call({ mode: 'mailto', mailto: 'mailto:leave@news.test?subject=stop' })).status).toBe(200);
		expect(mocks.sendEmail).toHaveBeenCalledWith(
			expect.anything(),
			'A1',
			expect.objectContaining({ to: [{ name: null, email: 'leave@news.test' }], subject: 'stop' }),
			expect.anything(),
			expect.anything()
		);
	});

	it('404s when the email is gone', async () => {
		mailServer(null);
		expect((await call({ mode: 'one-click', url: 'https://news.test/u/abc' })).status).toBe(404);
	});

	it('asks the mail server for List-Unsubscribe in raw form, which Stalwart 1.0 accepts', async () => {
		// RFC 8621 allows no Text form for this RFC 2369 header; `:asText` makes
		// Stalwart 1.0 reject the whole Email/get.
		mailServer(ONE_CLICK);
		mocks.safeFetch.mockResolvedValue({ bytes: Buffer.from(''), contentType: null, status: 200 });
		await call({ mode: 'one-click', url: 'https://news.test/u/abc' });
		const get = mocks.request.mock.calls
			.flatMap((args) => args[0] as [string, { properties?: string[] }, string][])
			.find(([name]) => name === 'Email/get');
		expect(get?.[1].properties).toContain('header:list-unsubscribe');
		expect(get?.[1].properties).not.toContain('header:list-unsubscribe:asText');
	});
});
