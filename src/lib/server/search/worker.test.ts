import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'ameera-searchworker-')), 'test.db');

const env = vi.hoisted(() => ({}) as Record<string, string | undefined>);
vi.mock('$env/dynamic/private', () => ({ env }));
const jmap = vi.hoisted(() => ({ box: null as unknown, boxes: new Map<string, unknown>() }));
vi.mock('$lib/jmap/auth', () => ({
	createClient: (auth: { accountId: string }) => jmap.boxes.get(auth.accountId) ?? jmap.box
}));
const logEvent = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/log', () => ({
	logEvent,
	errorFields: (err: unknown) => ({ error: err instanceof Error ? err.message : String(err) })
}));

import { getDb } from '$lib/server/db/index';
import { runMigrations } from '$lib/server/db/migrate';
import type { AuthState } from '$lib/jmap/types';
import { FakeMailbox, fakeOllama, FAKE_DIMS, type FakeOllama } from './__fixtures__/fakes';
import { getIndexState, indexProgress, pendingEmailIds, setIndexEnabled, updateIndexState } from './store';
import { accountVectors, forgetVectors, loadedVectors } from './vectors';
import { embedBatch, runIndexer, syncAccount } from './worker';

const ACCT = 'acct-1';
const auth = { authHeader: 'Basic x', accountId: 'jmap-acc', apiUrl: 'https://mail.example/jmap/', sessionState: '' } as AuthState;
/** A second linked account, with its own mailbox, for the loop over accounts. */
const ACCT2 = 'acct-2';
const auth2 = { ...auth, accountId: 'jmap-acc-2' } as AuthState;
let box: FakeMailbox;
let ollama: FakeOllama;

const minute = (n: number) => new Date(Date.UTC(2026, 0, 1) + n * 60_000).toISOString().replace('.000Z', 'Z');
const events = (name: string) => logEvent.mock.calls.filter((c) => c[2] === name);

/** Embed until the queue is empty, as the background loop would. */
async function drain() {
	for (let i = 0; i < 1000 && pendingEmailIds(ACCT, 1).length; i++) {
		expect(await embedBatch(ACCT, auth)).toBe(true);
	}
}

beforeAll(() => {
	runMigrations();
	getDb().prepare(`INSERT INTO app_user (id, email, password_hash) VALUES ('user-1', 'me@example.test', 'x')`).run();
	getDb()
		.prepare(
			`INSERT INTO mail_accounts (id, user_id, email, server_url, jmap_account_id, secret_enc)
			 VALUES (?, 'user-1', 'me@example.test', 'https://mail.example', 'jmap', 'x')`
		)
		.run(ACCT);
	getDb()
		.prepare(
			`INSERT INTO mail_accounts (id, user_id, email, server_url, jmap_account_id, secret_enc)
			 VALUES (?, 'user-1', 'two@example.test', 'https://mail.example', 'jmap-2', 'x')`
		)
		.run(ACCT2);
});

beforeEach(() => {
	env.EMBED_URL = 'http://ollama:11434';
	env.EMBED_MODEL = 'embeddinggemma-2:270m';
	box = new FakeMailbox();
	jmap.box = box;
	jmap.boxes.clear();
	ollama = fakeOllama();
	vi.stubGlobal('fetch', ollama.fetch);
	logEvent.mockClear();
	setIndexEnabled(ACCT, false);
	setIndexEnabled(ACCT, true);
	setIndexEnabled(ACCT2, false);
	forgetVectors(ACCT);
	forgetVectors(ACCT2);
});

/** Both accounts, as the schedulers see them, `first` ahead of the other. */
async function scheduleBoth(first = ACCT) {
	const accounts = await import('$lib/server/auth/accounts');
	const one = { account: { id: ACCT } as never, auth, email: 'me@example.test' };
	const two = { account: { id: ACCT2 } as never, auth: auth2, email: 'two@example.test' };
	vi.spyOn(accounts, 'listSchedulableAuths').mockReturnValue(first === ACCT ? [one, two] : [two, one]);
}

afterAll(() => vi.unstubAllGlobals());

describe('the search indexer', () => {
	it('does nothing for an account that has it off', async () => {
		setIndexEnabled(ACCT, false);
		box.add({ id: 'a', receivedAt: minute(1) });
		await syncAccount(ACCT, auth);
		expect(box.calls).toEqual([]);
	});

	it('lists every message, newest first, and embeds the newest first', async () => {
		// 1,203 messages, with 40 sharing one second across the first page's edge.
		for (let i = 0; i < 1203; i++) {
			const at = i >= 480 && i < 520 ? minute(10_000 - 480) : minute(10_000 - i);
			box.add({ id: `m${String(i).padStart(4, '0')}`, receivedAt: at, subject: `Message ${i}`, body: 'Hello there' });
		}
		await syncAccount(ACCT, auth);
		expect(indexProgress(ACCT)).toMatchObject({ total: 1203, pending: 1203 });
		expect(getIndexState(ACCT)).toMatchObject({ listed: true, ready: false, model: 'embeddinggemma-2:270m' });

		expect(await embedBatch(ACCT, auth)).toBe(true);
		expect(ollama.requests[0][0]).toMatch(/^title: Message 0 \| text: From: someone@example\.com\nHello there$/);
		await drain();
		expect(getIndexState(ACCT)).toMatchObject({ ready: true, dimensions: FAKE_DIMS, lastError: null });
		expect(events('index_ready')).toHaveLength(1);
		expect(accountVectors(ACCT, FAKE_DIMS)!.size).toBe(1203);
	});

	it('picks up new mail, moves and deletions from Email/changes', async () => {
		box.add({ id: 'a', receivedAt: minute(1), body: 'flight' }, { id: 'b', receivedAt: minute(2), body: 'school' });
		await syncAccount(ACCT, auth);
		await drain();
		const loaded = accountVectors(ACCT, FAKE_DIMS)!;
		expect(loaded.size).toBe(2);

		box.add({ id: 'c', receivedAt: minute(3), body: 'pipe leak' });
		box.move('a', ['archive']);
		box.destroy('b');
		await syncAccount(ACCT, auth);
		expect(pendingEmailIds(ACCT, 10)).toEqual(['c']);
		await drain();

		expect(loaded.has('b')).toBe(false);
		expect(loaded.has('c')).toBe(true);
		const inArchive = loaded.search(new Float32Array(FAKE_DIMS).fill(1), 10, (m) => m.mailboxIds.includes('archive'));
		expect(inArchive.map((n) => n.id)).toEqual(['a']);
		expect(indexProgress(ACCT).total).toBe(2);
	});

	it('lists everything again when the server can no longer say what changed', async () => {
		box.add({ id: 'a', receivedAt: minute(1) }, { id: 'b', receivedAt: minute(2) });
		await syncAccount(ACCT, auth);
		await drain();
		box.destroy('a');
		box.forgetHistory();
		await syncAccount(ACCT, auth);
		expect(events('relisting')).toHaveLength(1);
		expect(indexProgress(ACCT)).toMatchObject({ total: 1, done: 1 });
		expect(getIndexState(ACCT)?.ready).toBe(true);
	});

	it('waits out an unreachable endpoint without giving up on any message, and logs it once', async () => {
		box.add({ id: 'a', receivedAt: minute(1) });
		await syncAccount(ACCT, auth);
		ollama.failure = 'down';
		expect(await embedBatch(ACCT, auth)).toBe(false);
		expect(await embedBatch(ACCT, auth)).toBe(false);
		expect(events('embed_failed')).toHaveLength(1);
		expect(getIndexState(ACCT)?.lastError).toMatch(/Unreachable/);
		expect(pendingEmailIds(ACCT, 10)).toEqual(['a']);

		ollama.failure = null;
		expect(await embedBatch(ACCT, auth)).toBe(true);
		expect(getIndexState(ACCT)).toMatchObject({ lastError: null, ready: true });
		expect(events('embed_recovered')).toHaveLength(1);
	});

	it('logs a mail server failure once while it lasts, and once when it clears', async () => {
		const accounts = await import('$lib/server/auth/accounts');
		vi.spyOn(accounts, 'listSchedulableAuths').mockReturnValue([{ account: { id: ACCT } as never, auth, email: 'me@example.test' }]);
		box.add({ id: 'a', receivedAt: minute(1) });
		const down = vi.spyOn(box, 'request').mockRejectedValue(new Error('JMAP request failed: 502'));
		await runIndexer();
		await runIndexer();
		expect(events('sync_failed')).toHaveLength(1);
		down.mockRestore();
		await runIndexer();
		await runIndexer();
		expect(events('sync_recovered')).toHaveLength(1);
		// Let the background embedding the pass started finish here.
		await vi.waitFor(() => expect(pendingEmailIds(ACCT, 1)).toEqual([]));
		vi.restoreAllMocks();
	});

	it('skips a message the endpoint keeps refusing, after three tries', async () => {
		box.add({ id: 'a', receivedAt: minute(1) });
		await syncAccount(ACCT, auth);
		ollama.failure = 400;
		for (let i = 0; i < 3; i++) expect(await embedBatch(ACCT, auth)).toBe(true);
		expect(indexProgress(ACCT)).toMatchObject({ failed: 1, pending: 0 });
		expect(events('embed_refused')).toHaveLength(3);
		// An index with nothing in it answers nothing, so it isn't ready.
		expect(getIndexState(ACCT)).toMatchObject({ ready: false, lastError: expect.stringMatching(/refused every message/) });
	});

	it('skips only the message the endpoint refuses, and keeps the rest of its batch', async () => {
		box.add(
			{ id: 'a', receivedAt: minute(1), body: 'fine' },
			{ id: 'b', receivedAt: minute(2), body: 'poison' },
			{ id: 'c', receivedAt: minute(3), body: 'fine too' }
		);
		await syncAccount(ACCT, auth);
		ollama.refuses = /poison/;
		expect(await embedBatch(ACCT, auth)).toBe(true);
		// The batch, then each message on its own.
		expect(ollama.requests.map((inputs) => inputs.length)).toEqual([3, 1, 1, 1]);
		expect(indexProgress(ACCT)).toMatchObject({ done: 2, pending: 1, failed: 0 });
		await drain();
		expect(indexProgress(ACCT)).toMatchObject({ done: 2, failed: 1, pending: 0 });
		expect(getIndexState(ACCT)).toMatchObject({ ready: true, lastError: null });
		expect(events('embed_refused').map((c) => c[3].email)).toEqual(['b', 'b', 'b']);
	});

	it('treats an endpoint that refuses everything as down, not as bad mail', async () => {
		box.add({ id: 'a', receivedAt: minute(1) }, { id: 'b', receivedAt: minute(2) });
		await syncAccount(ACCT, auth);
		ollama.failure = 400;
		expect(await embedBatch(ACCT, auth)).toBe(false);
		expect(indexProgress(ACCT)).toMatchObject({ pending: 2, failed: 0 });
		expect(getIndexState(ACCT)?.lastError).toMatch(/400/);
		ollama.failure = null;
		await drain();
		expect(getIndexState(ACCT)).toMatchObject({ ready: true, lastError: null });
	});

	it('clears a stale error when the index finishes', async () => {
		updateIndexState(ACCT, { lastError: 'Unreachable: fetch failed' });
		await syncAccount(ACCT, auth);
		expect(getIndexState(ACCT)).toMatchObject({ ready: true, lastError: null });
	});

	it('drops what was embedded for a model that changed meanwhile', async () => {
		box.add({ id: 'a', receivedAt: minute(1) });
		await syncAccount(ACCT, auth);
		const embedding = embedBatch(ACCT, auth);
		env.EMBED_MODEL = 'bge-m3';
		await syncAccount(ACCT, auth);
		expect(await embedding).toBe(true);
		expect(indexProgress(ACCT)).toMatchObject({ pending: 1, done: 0 });
		expect(getDb().prepare('SELECT COUNT(*) AS n FROM search_vectors').get()).toEqual({ n: 0 });
	});

	it('warms a ready index on its pass, so a search after a restart finds it in memory', async () => {
		await scheduleBoth();
		box.add({ id: 'a', receivedAt: minute(1) });
		await syncAccount(ACCT, auth);
		await drain();
		forgetVectors(ACCT);
		expect(loadedVectors(ACCT)).toBeUndefined();
		await runIndexer();
		expect(loadedVectors(ACCT)?.size).toBe(1);
		vi.restoreAllMocks();
	});

	it('goes on with the other accounts when one’s turn fails', async () => {
		await scheduleBoth(ACCT2);
		const box2 = new FakeMailbox();
		jmap.boxes.set(auth2.accountId, box2);
		for (let i = 0; i < 20; i++) box.add({ id: `m${i}`, receivedAt: minute(i) });
		box2.add({ id: 'x', receivedAt: minute(1) });
		setIndexEnabled(ACCT2, true);
		// The second account lists fine, but its server fails when bodies are fetched for embedding.
		const request = box2.request.bind(box2);
		vi.spyOn(box2, 'request').mockImplementation((calls) =>
			calls.some(([, args]) => (args as { fetchTextBodyValues?: boolean }).fetchTextBodyValues)
				? Promise.reject(new Error('JMAP request failed: 502'))
				: request(calls)
		);
		await runIndexer();
		await vi.waitFor(() => expect(pendingEmailIds(ACCT, 1)).toEqual([]));
		expect(pendingEmailIds(ACCT2, 1)).toEqual(['x']);
		expect(events('index_failed')).toHaveLength(1);
		vi.restoreAllMocks();
	});

	it('takes in an account switched on while another’s backlog is being embedded', async () => {
		await scheduleBoth();
		const box2 = new FakeMailbox();
		jmap.boxes.set(auth2.accountId, box2);
		for (let i = 0; i < 40; i++) box.add({ id: `m${i}`, receivedAt: minute(i) });
		box2.add({ id: 'x', receivedAt: minute(1) });
		await runIndexer();
		setIndexEnabled(ACCT2, true);
		await syncAccount(ACCT2, auth2);
		await vi.waitFor(() => expect(pendingEmailIds(ACCT2, 1)).toEqual([]));
		await vi.waitFor(() => expect(pendingEmailIds(ACCT, 1)).toEqual([]));
		expect(getIndexState(ACCT2)?.ready).toBe(true);
		vi.restoreAllMocks();
	});

	it('starts over when the model changes', async () => {
		box.add({ id: 'a', receivedAt: minute(1) });
		await syncAccount(ACCT, auth);
		await drain();
		env.EMBED_MODEL = 'bge-m3';
		await syncAccount(ACCT, auth);
		expect(getIndexState(ACCT)).toMatchObject({ model: 'bge-m3', ready: false, dimensions: null });
		expect(pendingEmailIds(ACCT, 10)).toEqual(['a']);
		expect(events('model_changed')).toEqual([[ 'info', 'search', 'model_changed', { from: 'embeddinggemma-2:270m', to: 'bge-m3' } ]]);
	});

	it('drops a message deleted while its batch was being embedded', async () => {
		box.add({ id: 'a', receivedAt: minute(1) });
		await syncAccount(ACCT, auth);
		const embedding = embedBatch(ACCT, auth);
		box.destroy('a');
		await syncAccount(ACCT, auth);
		expect(await embedding).toBe(true);
		expect(indexProgress(ACCT).total).toBe(0);
		expect(getDb().prepare('SELECT COUNT(*) AS n FROM search_vectors').get()).toEqual({ n: 0 });
	});
});
