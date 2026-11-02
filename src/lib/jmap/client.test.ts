import { afterEach, describe, expect, it, vi } from 'vitest';
import { JMAPClient, JMAPMethodError } from './client';

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('JMAPClient.request', () => {
	it('abandons a request the server never answers, as a plain failure to reach it', async () => {
		// A server that accepts the connection and then hangs: the fetch only
		// settles when its signal fires.
		const fetchMock = vi.fn(
			(_url: string, init: RequestInit) =>
				new Promise<Response>((_, reject) => {
					init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
				})
		);
		vi.stubGlobal('fetch', fetchMock);

		const client = new JMAPClient('https://mail.example.test/jmap/', 'Basic x', 20);
		await expect(client.request([['Mailbox/get', { accountId: 'a' }, '0']])).rejects.toMatchObject({
			name: 'TimeoutError'
		});
	});

	it('sends a timeout with every request by default, and still raises method errors', async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ methodResponses: [['error', { type: 'serverUnavailable' }, '0']] }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			})
		);
		vi.stubGlobal('fetch', fetchMock);

		const client = new JMAPClient('https://mail.example.test/jmap/', 'Basic x');
		await expect(client.request([['Mailbox/get', { accountId: 'a' }, '0']])).rejects.toBeInstanceOf(JMAPMethodError);
		expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
	});
});
