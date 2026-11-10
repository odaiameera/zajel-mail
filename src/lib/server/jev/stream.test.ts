import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const accounts = vi.hoisted(() => ({
	list: [] as { account: { id: string; email: string }; auth: { apiUrl: string; authHeader: string } }[],
	reauth: vi.fn(),
	jevOn: new Set<string>(),
	mode: 'live' as 'live' | 'off'
}));
vi.mock('$lib/server/auth/accounts', () => ({
	listSchedulableAuths: () => accounts.list,
	markNeedsReauth: accounts.reauth
}));
vi.mock('$lib/server/db/queries/jev-settings', () => ({
	getJevSettings: (id: string) => ({ jevEnabled: accounts.jevOn.has(id) })
}));
vi.mock('./client', () => ({ jevMode: () => accounts.mode }));

import { startJevWatchers, stopJevWatchers } from './stream';

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
	accounts.mode = 'live';
	accounts.reauth.mockReset();
});

afterEach(() => {
	stopJevWatchers();
	vi.unstubAllGlobals();
});

describe('Jev’s event streams', () => {
	it('runs a pass when a stream opens and again shortly after each Email change', async () => {
		const stream = openStream();
		const fetchMock = vi.fn().mockResolvedValue(stream.response);
		vi.stubGlobal('fetch', fetchMock);
		const runPass = vi.fn(async () => {});

		startJevWatchers(runPass);

		// Only the account Jev reads gets a stream.
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
		expect(fetchMock.mock.calls[0][0]).toBe('https://mail.example/jmap/a/eventsource/?types=Email&closeafter=no&ping=60');
		// Mail may have landed while no stream was open.
		await vi.waitFor(() => expect(runPass).toHaveBeenCalledTimes(1), { timeout: 3000 });
		expect(runPass).toHaveBeenCalledWith('a', 'a@example.test', accounts.list[0].auth);

		stream.push(': ping\n\n');
		stream.push('event: state\ndata: {"@type":"StateChange","changed":{"acc":{"Email":"s2"}}}\n\n');
		await vi.waitFor(() => expect(runPass).toHaveBeenCalledTimes(2), { timeout: 3000 });
	});

	it('opens nothing while Jev can’t answer at all', async () => {
		accounts.mode = 'off';
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);

		startJevWatchers(vi.fn());
		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('stops and flags the account when the mail server refuses its password', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 401 })));

		startJevWatchers(vi.fn());

		await vi.waitFor(() => expect(accounts.reauth).toHaveBeenCalledWith('a'));
	});
});
