import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const accounts = vi.hoisted(() => ({
	list: [] as { account: { id: string; email: string }; auth: { apiUrl: string; authHeader: string } }[],
	reauth: vi.fn(),
	jevOn: new Set<string>(),
	/** Accounts whose Inbox holds new mail for their sender pins. */
	holding: new Set<string>(),
	mode: 'live' as 'live' | 'off'
}));
vi.mock('$lib/server/auth/accounts', () => ({
	listSchedulableAuths: () => accounts.list,
	markNeedsReauth: accounts.reauth
}));
// What each account's pass has to do: Jev reads it (while Jev can answer at
// all), or its Inbox holds new mail.
vi.mock('./needs', () => ({
	pipelineNeeds: (id: string) => ({ jev: accounts.mode !== 'off' && accounts.jevOn.has(id), hold: accounts.holding.has(id) })
}));

import { refreshStreams, startStreams, stopStreams } from './stream';

/** An event stream the test writes to, as the mail server would. */
function openStream() {
	let push!: (text: string) => void;
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			push = (text) => controller.enqueue(new TextEncoder().encode(text));
		}
	});
	return { response: new Response(body, { status: 200 }), push: (text: string) => push(text) };
}

const account = (id: string) => ({
	account: { id, email: `${id}@example.test` },
	auth: { apiUrl: `https://mail.example/jmap/${id}/`, authHeader: 'Basic x' }
});

beforeEach(() => {
	accounts.list = [account('a'), account('b')];
	accounts.jevOn = new Set(['a']);
	accounts.holding = new Set();
	accounts.mode = 'live';
	accounts.reauth.mockReset();
});

afterEach(() => {
	stopStreams();
	vi.unstubAllGlobals();
});

describe('the new-mail event streams', () => {
	it('runs a pass when a stream opens and again shortly after each Email change', async () => {
		const stream = openStream();
		const fetchMock = vi.fn().mockResolvedValue(stream.response);
		vi.stubGlobal('fetch', fetchMock);
		const runPass = vi.fn(async () => {});

		startStreams(runPass);

		// Only the account Jev reads gets a stream.
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
		expect(fetchMock.mock.calls[0][0]).toBe('https://mail.example/jmap/a/eventsource/?types=Email&closeafter=no&ping=60');
		// Mail may have landed while no stream was open.
		await vi.waitFor(() => expect(runPass).toHaveBeenCalledTimes(1), { timeout: 3000 });
		expect(runPass).toHaveBeenCalledWith('a', accounts.list[0].auth, { fromStream: true });

		stream.push(': ping\n\n');
		stream.push('event: state\ndata: {"@type":"StateChange","changed":{"acc":{"Email":"s2"}}}\n\n');
		await vi.waitFor(() => expect(runPass).toHaveBeenCalledTimes(2), { timeout: 3000 });
	});

	it('opens nothing while Jev can’t answer at all', async () => {
		accounts.mode = 'off';
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);

		startStreams(vi.fn());
		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('opens a stream for an account whose Inbox waits on sender pins, though Jev can’t answer', async () => {
		accounts.mode = 'off';
		accounts.holding = new Set(['b']);
		const stream = openStream();
		const fetchMock = vi.fn().mockResolvedValue(stream.response);
		vi.stubGlobal('fetch', fetchMock);
		const runPass = vi.fn(async () => {});

		startStreams(runPass);

		// Without it every new message in that Inbox would wait for the minute's run.
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
		expect(fetchMock.mock.calls[0][0]).toBe('https://mail.example/jmap/b/eventsource/?types=Email&closeafter=no&ping=60');
		await vi.waitFor(() => expect(runPass).toHaveBeenCalledWith('b', accounts.list[1].auth, { fromStream: true }), {
			timeout: 3000
		});
	});

	it('stops and flags the account when the mail server refuses its password', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 401 })));

		startStreams(vi.fn());

		await vi.waitFor(() => expect(accounts.reauth).toHaveBeenCalledWith('a'));
	});

	it('opens a new stream for an account linked again after its password was refused', async () => {
		let calls = 0;
		const fetchMock = vi.fn(async () => (++calls === 1 ? new Response('', { status: 401 }) : openStream().response));
		vi.stubGlobal('fetch', fetchMock);
		startStreams(vi.fn(async () => {}));
		await vi.waitFor(() => expect(accounts.reauth).toHaveBeenCalledWith('a'));

		// Linked again before the next reconcile: the account is schedulable.
		refreshStreams();

		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
	});

	it('gives up on a stream that goes silent, and opens another', async () => {
		vi.useFakeTimers();
		try {
			// A stream that never sends a byte, not even a ping, and ends when aborted.
			const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
				const body = new ReadableStream<Uint8Array>({
					start(controller) {
						init?.signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
					}
				});
				return new Response(body, { status: 200 });
			});
			vi.stubGlobal('fetch', fetchMock);
			startStreams(vi.fn(async () => {}));
			await vi.advanceTimersByTimeAsync(10);
			expect(fetchMock).toHaveBeenCalledTimes(1);

			// Three missed pings, then the first backoff.
			await vi.advanceTimersByTimeAsync(3 * 60_000 + 5_000 + 10);
			expect(fetchMock).toHaveBeenCalledTimes(2);
			expect((fetchMock.mock.calls[0][1] as RequestInit).signal?.aborted).toBe(true);
		} finally {
			stopStreams();
			vi.useRealTimers();
		}
	});
});
