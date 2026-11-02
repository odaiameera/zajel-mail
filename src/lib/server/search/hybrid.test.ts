import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'ameera-hybrid-')), 'test.db');

const env = vi.hoisted(() => ({}) as Record<string, string | undefined>);
vi.mock('$env/dynamic/private', () => ({ env }));
const jmap = vi.hoisted(() => ({ box: null as unknown }));
vi.mock('$lib/jmap/auth', () => ({ createClient: () => jmap.box }));
const logEvent = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/log', () => ({
	logEvent,
	errorFields: (err: unknown) => ({ error: err instanceof Error ? err.message : String(err) })
}));

import { getDb } from '$lib/server/db/index';
import { runMigrations } from '$lib/server/db/migrate';
import type { JMAPClient } from '$lib/jmap/client';
import type { AuthState } from '$lib/jmap/types';
import { FAKE_DIMS, fakeEmbedding, FakeMailbox, fakeOllama, type FakeOllama } from './__fixtures__/fakes';
import { normalize } from './embed';
import { reciprocalRankFusion, resetSearchPauseForTests, searchMail, type MailSearchInput } from './hybrid';
import { getIndexState, pendingEmailIds, setIndexEnabled, storeVectors, upsertEmails } from './store';
import { forgetVectors, LOAD_STEP, loadVectors, quantize } from './vectors';
import { embedBatch, syncAccount } from './worker';

const ACCT = 'acct-1';
const auth = { authHeader: 'Basic x', accountId: 'jmap-acc', apiUrl: 'https://mail.example/jmap/', sessionState: '' } as AuthState;
const minute = (n: number) => new Date(Date.UTC(2026, 0, 1) + n * 60_000).toISOString().replace('.000Z', 'Z');

let box: FakeMailbox;
let ollama: FakeOllama;

function search(filter: Record<string, unknown>, options: Partial<MailSearchInput> = {}) {
	return searchMail({ client: box as unknown as JMAPClient, accountId: 'jmap-acc', accountRowId: ACCT, filter, ...options });
}

async function buildIndex() {
	await syncAccount(ACCT, auth);
	while (pendingEmailIds(ACCT, 1).length) await embedBatch(ACCT, auth);
	expect(getIndexState(ACCT)?.ready).toBe(true);
	ollama.requests.length = 0;
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
});

beforeEach(() => {
	env.EMBED_URL = 'http://ollama:11434';
	env.EMBED_MODEL = 'embeddinggemma-2:270m';
	box = new FakeMailbox();
	jmap.box = box;
	ollama = fakeOllama();
	vi.stubGlobal('fetch', ollama.fetch);
	logEvent.mockClear();
	resetSearchPauseForTests();
	setIndexEnabled(ACCT, false);
	setIndexEnabled(ACCT, true);
	forgetVectors(ACCT);

	box.add(
		{ id: 'p1', receivedAt: minute(10), subject: 'Quote from the plumber', body: 'Here is the plumber quote for the kitchen.', from: 'sam@plumb.example' },
		{ id: 'p2', receivedAt: minute(20), subject: 'Leaking pipe estimate', body: 'Estimate to fix the leaking pipe: 300.', from: 'sam@plumb.example', mailboxIds: ['archive'] },
		{ id: 'p3', receivedAt: minute(30), subject: 'عرض سعر', body: 'سباك: عرض سعر لإصلاح تسريب المطبخ', from: 'abu.khaled@example.jo' },
		{ id: 't1', receivedAt: minute(40), subject: 'Your flight', body: 'Boarding pass for your flight.' },
		{ id: 's1', receivedAt: minute(50), subject: 'School news', body: 'Homework for the class this week.' }
	);
	for (let i = 0; i < 60; i++) {
		box.add({ id: `f${i}`, receivedAt: minute(100 + i), subject: `Update ${i}`, body: `Lorem ipsum dolor ${i} sit amet consectetur adipiscing elit ${i * 7}` });
	}
});

afterAll(() => vi.unstubAllGlobals());

describe('reciprocalRankFusion', () => {
	it('puts what both lists found first, then alternates by rank', () => {
		expect(reciprocalRankFusion([['a', 'b', 'c'], ['x', 'b', 'y']])).toEqual(['b', 'a', 'x', 'c', 'y']);
	});
});

describe('searchMail', () => {
	it('is plain keyword search, newest first, until the index is complete', async () => {
		await syncAccount(ACCT, auth);
		await embedBatch(ACCT, auth);
		ollama.requests.length = 0;
		const result = await search({ text: 'plumber quote' });
		expect(result).toMatchObject({ ranked: false, total: 1 });
		expect(result.emails.map((e) => e.id)).toEqual(['p1']);
		expect(ollama.requests).toEqual([]);
	});

	it('adds what means the same, in any language, below what both sides found', async () => {
		await buildIndex();
		const result = await search({ text: 'plumber quote' });
		expect(result.ranked).toBe(true);
		expect(result.emails[0].id).toBe('p1');
		expect(new Set(result.emails.map((e) => e.id))).toEqual(new Set(['p1', 'p2', 'p3']));
		expect(result.total).toBe(3);
		expect(ollama.requests).toEqual([['task: search result | query: plumber quote']]);
	});

	it('holds vector matches to the rest of the filter', async () => {
		await buildIndex();
		const inArchive = await search({ operator: 'AND', conditions: [{ text: 'plumber quote' }, { inMailbox: 'archive' }] });
		expect(inArchive.emails.map((e) => e.id)).toEqual(['p2']);
		const fromAbu = await search({ operator: 'AND', conditions: [{ text: 'plumber quote' }, { from: 'abu' }] });
		expect(fromAbu.emails.map((e) => e.id)).toEqual(['p3']);
	});

	it('judges a small folder against the whole mailbox, so it isn’t all matches', async () => {
		box.add(
			{ id: 'q1', receivedAt: minute(60), subject: 'Estimate for the kitchen pipe', body: 'The leaking pipe will cost 300 to fix.', mailboxIds: ['small'] },
			{ id: 'q2', receivedAt: minute(61), subject: 'School news', body: 'Homework for the class.', mailboxIds: ['small'] },
			{ id: 'q3', receivedAt: minute(62), subject: 'Weekly digest', body: 'Your weekly newsletter.', mailboxIds: ['small'] }
		);
		await buildIndex();
		// Nothing in the folder has both words, so this is the vectors alone.
		const inSmall = await search({ operator: 'AND', conditions: [{ text: 'plumber quote' }, { inMailbox: 'small' }] });
		expect(inSmall).toMatchObject({ ranked: true, total: 1 });
		expect(inSmall.emails.map((e) => e.id)).toEqual(['q1']);
		const nothing = await search({ operator: 'AND', conditions: [{ text: 'flight' }, { inMailbox: 'small' }] });
		expect(nothing).toMatchObject({ ranked: false, total: 0 });
	});

	it('answers by keyword while a large index is still being read into memory, then by meaning', async () => {
		await buildIndex();
		// More vectors than one load step: after a restart they are read in the background.
		const many = Array.from({ length: LOAD_STEP }, (_, i) => ({ id: `big${i}`, receivedAt: minute(2000 + i), mailboxIds: ['inbox'] }));
		upsertEmails(ACCT, many, 0);
		const filler = [quantize(normalize(fakeEmbedding('lorem ipsum')))];
		getDb().transaction(() => {
			for (const e of many) storeVectors(ACCT, e.id, filler);
		})();
		forgetVectors(ACCT);

		expect(await search({ text: 'plumber quote' })).toMatchObject({ ranked: false, total: 1 });
		await loadVectors(ACCT, FAKE_DIMS);
		expect(await search({ text: 'plumber quote' })).toMatchObject({ ranked: true, total: 3 });
	});

	it('falls back to keyword results when Ollama is down, logs it, and stops asking for a while', async () => {
		await buildIndex();
		ollama.failure = 'down';
		const result = await search({ text: 'plumber quote' });
		expect(result).toMatchObject({ ranked: false, total: 1 });
		expect(logEvent).toHaveBeenCalledWith('warn', 'search', 'vector_search_failed', expect.objectContaining({ error: expect.stringMatching(/Unreachable/) }));

		ollama.failure = null;
		await search({ text: 'plumber quote' });
		expect(ollama.requests).toEqual([]);
	});

	it('logs a failure once while it lasts, and once when it clears', async () => {
		await buildIndex();
		vi.useFakeTimers({ toFake: ['Date'] });
		try {
			const failures = () => logEvent.mock.calls.filter((c) => c[2] === 'vector_search_failed').length;
			ollama.failure = 'down';
			await search({ text: 'plumber quote' });
			vi.setSystemTime(Date.now() + 61_000);
			await search({ text: 'flight' });
			expect(failures()).toBe(1);

			ollama.failure = null;
			vi.setSystemTime(Date.now() + 61_000);
			expect((await search({ text: 'plumber quote' })).ranked).toBe(true);
			await search({ text: 'flight' });
			expect(logEvent.mock.calls.filter((c) => c[2] === 'vector_search_recovered')).toHaveLength(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it('still fails loudly when the keyword search itself fails', async () => {
		await buildIndex();
		const broken = { request: async () => { throw new Error('JMAP request failed: 500'); } } as unknown as JMAPClient;
		await expect(searchMail({ client: broken, accountId: 'jmap-acc', accountRowId: ACCT, filter: { text: 'plumber' } })).rejects.toThrow('500');
	});

	async function pageThrough(text: string, limit: number) {
		const first = await search({ text }, { limit });
		const seen = first.emails.map((e) => e.id);
		for (let position = limit; position < first.total; position += limit) {
			const page = await search({ text }, { position, limit });
			expect(page.total).toBe(first.total);
			seen.push(...page.emails.map((e) => e.id));
		}
		return { first, seen };
	}

	it('pages through every match exactly once, with an exact total', async () => {
		for (let i = 0; i < 20; i++) box.add({ id: `w${i}`, receivedAt: minute(1000 + i), subject: `Weekly ${i}`, body: 'Your weekly roundup' });
		box.add({ id: 'digest', receivedAt: minute(5), subject: 'Monthly digest', body: 'All the month in one email' });
		await buildIndex();

		const { first, seen } = await pageThrough('weekly', 5);
		expect(first.ranked).toBe(true);
		expect(first.total).toBe(21);
		expect(seen).toHaveLength(21);
		expect(new Set(seen)).toEqual(new Set([...Array.from({ length: 20 }, (_, i) => `w${i}`), 'digest']));
	});

	it('still shows every keyword match once when the server caps how many ids a query returns', async () => {
		for (let i = 0; i < 20; i++) box.add({ id: `w${i}`, receivedAt: minute(1000 + i), subject: `Weekly ${i}`, body: 'Your weekly roundup' });
		await buildIndex();
		box.maxResults = 8;

		const { first, seen } = await pageThrough('weekly', 5);
		expect(new Set(seen)).toEqual(new Set(Array.from({ length: 20 }, (_, i) => `w${i}`)));
		expect(seen).toHaveLength(20);
		// Matches the vectors placed from beyond the cap are counted twice.
		expect(first.total).toBeGreaterThanOrEqual(20);
	});
});
