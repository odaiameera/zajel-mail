import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const accounts = vi.hoisted(() => ({
	list: [] as { account: { id: string; email: string }; auth: { apiUrl: string; authHeader: string } }[],
	reauth: vi.fn(),
	jevOn: new Set<string>(),
	/** Accounts whose Inbox holds new mail for their sender pins. */
	holding: new Set<string>(),
	/** Accounts with a rule that may run, and with out-of-office on. */
	rules: new Set<string>(),
	away: new Set<string>(),
	mode: 'live' as 'live' | 'off'
}));
vi.mock('$lib/server/auth/accounts', () => ({
	listSchedulableAuths: () => accounts.list,
	// refreshPipeline's note of the hold has nothing to do here (see pass.test.ts).
	listAllMailAccounts: () => [],
	markNeedsReauth: accounts.reauth
}));
// What each account's pass has to do: anything that acts on new mail (see
// needs.test.ts for how that is worked out).
vi.mock('./needs', () => ({
	pipelineNeeds: (id: string) => {
		const jev = accounts.mode !== 'off' && accounts.jevOn.has(id);
		const hold = accounts.holding.has(id);
		return { jev, hold, wantsArrivals: jev || hold || accounts.rules.has(id) || accounts.away.has(id) };
	}
}));

import { refreshStreams, startStreams, stopStreams } from './stream';
import { refreshPipeline } from './index';

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
	accounts.rules = new Set();
	accounts.away = new Set();
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

	it('opens a stream for an account with rules only, and for one with out-of-office only', async () => {
		accounts.mode = 'off';
		accounts.list = [account('a'), account('b'), account('c')];
		accounts.rules = new Set(['a']);
		accounts.away = new Set(['b']);
		const fetchMock = vi.fn(async () => openStream().response);
		vi.stubGlobal('fetch', fetchMock);

		startStreams(vi.fn(async () => {}));

		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
		expect(fetchMock.mock.calls.map((c) => (c as unknown[])[0]).sort()).toEqual([
			'https://mail.example/jmap/a/eventsource/?types=Email&closeafter=no&ping=60',
			'https://mail.example/jmap/b/eventsource/?types=Email&closeafter=no&ping=60'
		]);
	});

	it('opens a stream as soon as a rule or out-of-office is saved, and closes it when nothing is left', async () => {
		accounts.mode = 'off';
		const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => openStream().response);
		vi.stubGlobal('fetch', fetchMock);
		startStreams(vi.fn(async () => {}));
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(fetchMock).not.toHaveBeenCalled();

		// A rule saved for b (the rule routes call refreshPipeline).
		accounts.rules.add('b');
		refreshPipeline();
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
		expect(fetchMock.mock.calls[0][0]).toBe('https://mail.example/jmap/b/eventsource/?types=Email&closeafter=no&ping=60');

		// Out-of-office switched on (its save calls refreshPipeline too).
		accounts.away.add('a');
		refreshPipeline();
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
		expect(fetchMock.mock.calls[1][0]).toBe('https://mail.example/jmap/a/eventsource/?types=Email&closeafter=no&ping=60');

		// The rule deleted: b's stream is closed.
		accounts.rules.delete('b');
		refreshPipeline();
		expect((fetchMock.mock.calls[0][1] as RequestInit).signal?.aborted).toBe(true);
		expect((fetchMock.mock.calls[1][1] as RequestInit).signal?.aborted).toBe(false);
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
