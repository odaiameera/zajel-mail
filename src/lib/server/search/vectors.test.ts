import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { beforeAll, describe, expect, it } from 'vitest';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'ameera-vectors-')), 'test.db');

import { getDb } from '$lib/server/db/index';
import { runMigrations } from '$lib/server/db/migrate';
import { normalize } from './embed';
import {
	getIndexState,
	indexProgress,
	pendingEmailIds,
	recordAttempt,
	removeUnseen,
	restartWithModel,
	setIndexEnabled,
	storeVectors,
	upsertEmails
} from './store';
import {
	accountVectors,
	AccountVectors,
	forgetVectors,
	LOAD_STEP,
	loadedVectors,
	loadVectors,
	outlierFloor,
	quantize
} from './vectors';

const ACCT = 'acct-1';
const BIG = 'acct-2';
const unit = (...values: number[]) => normalize(values);

beforeAll(() => {
	runMigrations();
	getDb().prepare(`INSERT INTO app_user (id, email, password_hash) VALUES ('user-1', 'me@example.test', 'x')`).run();
	const account = getDb().prepare(
		`INSERT INTO mail_accounts (id, user_id, email, server_url, jmap_account_id, secret_enc)
		 VALUES (?, 'user-1', ?, 'https://mail.example', ?, 'x')`
	);
	account.run(ACCT, 'me@example.test', 'jmap');
	account.run(BIG, 'big@example.test', 'jmap-2');
});

describe('quantize', () => {
	it('keeps cosine similarity to within a hair of the float value', () => {
		const a = unit(0.3, -0.2, 0.9, 0.1);
		const b = unit(0.25, -0.1, 0.8, 0.4);
		const exact = a.reduce((sum, x, i) => sum + x * b[i], 0);
		const qa = quantize(a);
		const qb = quantize(b);
		const approx = qa.data.reduce((sum, x, i) => sum + x * qb.data[i], 0) * qa.scale * qb.scale;
		expect(Math.abs(approx - exact)).toBeLessThan(0.01);
	});
});

describe('outlierFloor', () => {
	// Shaped like embeddinggemma-2:270m's scores over ten test messages: the
	// top three and the median as measured, the rest filled in around them.
	const floor = (scores: number[]) => outlierFloor(Float32Array.from(scores), 3.5);

	it('lets the real matches through and holds back the closest unrelated one', () => {
		const plumbing = [0.803, 0.755, 0.589, 0.575, 0.566, 0.558, 0.552, 0.541, 0.53, 0.522];
		expect(plumbing.filter((s) => s >= floor(plumbing))).toEqual([0.803, 0.755]);
	});

	it('lets nothing through for a question nothing answers', () => {
		const nonsense = [0.502, 0.485, 0.485, 0.484, 0.484, 0.48, 0.478, 0.475, 0.47, 0.466];
		expect(nonsense.filter((s) => s >= floor(nonsense))).toEqual([]);
	});

	it('lets nothing through with too few scores to judge', () => {
		expect(floor([0.9, 0.2])).toBe(Infinity);
	});
});

describe('AccountVectors', () => {
	const meta = (id: string, receivedAt = 0, mailboxIds = ['IN']) => ({ id, receivedAt, mailboxIds });

	it('ranks messages by their best chunk', () => {
		const index = new AccountVectors(3);
		index.add(meta('far'), [quantize(unit(0, 0, 1))]);
		index.add(meta('two-chunks'), [quantize(unit(0, 1, 0)), quantize(unit(1, 0.1, 0))]);
		index.add(meta('near'), [quantize(unit(1, 0.4, 0))]);
		const hits = index.search(unit(1, 0, 0), 2);
		expect(hits.map((h) => h.id)).toEqual(['two-chunks', 'near']);
		expect(hits[0].score).toBeGreaterThan(hits[1].score);
	});

	it('filters before scoring, and forgets removed messages', () => {
		const index = new AccountVectors(2);
		index.add(meta('inbox', 0, ['IN']), [quantize(unit(1, 0))]);
		index.add(meta('archive', 0, ['AR']), [quantize(unit(1, 0.1))]);
		expect(index.search(unit(1, 0), 5, (m) => m.mailboxIds.includes('AR')).map((h) => h.id)).toEqual(['archive']);
		index.setMailboxes('inbox', ['AR']);
		expect(index.search(unit(1, 0), 5, (m) => m.mailboxIds.includes('AR'))).toHaveLength(2);
		index.remove('inbox');
		expect(index.search(unit(1, 0), 5).map((h) => h.id)).toEqual(['archive']);
		expect(index.size).toBe(1);
	});

	it('judges a small folder against the whole mailbox, not against itself', () => {
		const index = new AccountVectors(3);
		for (let i = 0; i < 30; i++) index.add(meta(`in${i}`, 0, ['IN']), [quantize(unit(1, (i % 5) / 10, 0))]);
		index.add(meta('pipe', 0, ['X']), [quantize(unit(0, 0.2, 1))]);
		index.add(meta('invoice', 0, ['X']), [quantize(unit(1, 0, 0))]);
		index.add(meta('school', 0, ['X']), [quantize(unit(0, 1, 0))]);
		const inX = (m: { mailboxIds: string[] }) => m.mailboxIds.includes('X');
		expect(index.search(unit(0, 0, 1), 10, inX, 3.5).map((h) => h.id)).toEqual(['pipe']);
		// Without a floor, the folder's three are all there, nearest first.
		expect(index.search(unit(0, 0, 1), 10, inX).map((h) => h.id)).toEqual(['pipe', 'invoice', 'school']);
	});

	it('returns nothing with a floor when the whole index is too small to judge', () => {
		const index = new AccountVectors(2);
		for (let i = 0; i < 5; i++) index.add(meta(`m${i}`), [quantize(unit(1, i / 5))]);
		expect(index.search(unit(1, 0), 5, () => true, 3.5)).toEqual([]);
		expect(index.search(unit(1, 0), 5)).toHaveLength(5);
	});

	it('replaces a message added twice, and compacts after many removals', () => {
		const index = new AccountVectors(2, 4);
		for (let i = 0; i < 3000; i++) index.add(meta(`m${i}`), [quantize(unit(1, i / 3000))]);
		index.add(meta('m0'), [quantize(unit(0, 1))]);
		for (let i = 1; i < 2500; i++) index.remove(`m${i}`);
		expect(index.size).toBe(501);
		expect(index.search(unit(0, 1), 1)[0].id).toBe('m0');
		expect(index.search(unit(1, 0), 600)).toHaveLength(501);
	});
});

describe('the store', () => {
	it('queues newest first, stores vectors, and loads them back for search', () => {
		setIndexEnabled(ACCT, true);
		upsertEmails(ACCT, [
			{ id: 'old', receivedAt: '2025-01-01T00:00:00Z', mailboxIds: ['IN'] },
			{ id: 'new', receivedAt: '2026-01-01T00:00:00Z', mailboxIds: ['IN', 'L1'] }
		], 0);
		expect(pendingEmailIds(ACCT, 10)).toEqual(['new', 'old']);

		expect(storeVectors(ACCT, 'new', [quantize(unit(1, 0)), quantize(unit(0, 1))])).toBe(true);
		expect(storeVectors(ACCT, 'gone', [quantize(unit(1, 0))])).toBe(false);
		expect(indexProgress(ACCT)).toEqual({ total: 2, done: 1, failed: 0, pending: 1 });

		forgetVectors(ACCT);
		const index = accountVectors(ACCT, 2)!;
		expect(index.size).toBe(1);
		expect(index.search(unit(0, 1), 5, (m) => m.mailboxIds.includes('L1'))[0].id).toBe('new');
	});

	it('reads a large index in steps, off the request path, and keeps a message split across steps whole', async () => {
		setIndexEnabled(BIG, true);
		const many = Array.from({ length: LOAD_STEP + 5 }, (_, i) => ({ id: `m${i}`, receivedAt: '2026-01-01T00:00:00Z', mailboxIds: ['IN'] }));
		upsertEmails(BIG, many, 0);
		// The last message of the first step has a second chunk, which lands in the second.
		const straddles = `m${LOAD_STEP - 1}`;
		getDb().transaction(() => {
			for (const e of many) {
				storeVectors(BIG, e.id, e.id === straddles ? [quantize(unit(0, 1)), quantize(unit(1, 0))] : [quantize(unit(1, 0))]);
			}
		})();

		// More than one step: not in memory yet, so a search goes on without it...
		expect(accountVectors(BIG, 2)).toBeNull();
		// ...while the indexer already has the copy being filled to keep current.
		expect(loadedVectors(BIG)).toBeDefined();
		const index = await loadVectors(BIG, 2);
		expect(index.size).toBe(LOAD_STEP + 5);
		expect(accountVectors(BIG, 2)).toBe(index);
		const [hit] = index.search(unit(0, 1), 1);
		expect(hit.id).toBe(straddles);
		expect(hit.score).toBeGreaterThan(0.99);

		forgetVectors(BIG);
		expect(loadedVectors(BIG)).toBeUndefined();
		setIndexEnabled(BIG, false);
	});

	it('gives up on a message after three failed attempts', () => {
		recordAttempt(ACCT, 'old');
		recordAttempt(ACCT, 'old');
		expect(pendingEmailIds(ACCT, 10)).toEqual(['old']);
		recordAttempt(ACCT, 'old');
		expect(pendingEmailIds(ACCT, 10)).toEqual([]);
		expect(indexProgress(ACCT).failed).toBe(1);
	});

	it('drops vectors and queues everything again for a new model', () => {
		restartWithModel(ACCT, 'bge-m3');
		expect(getIndexState(ACCT)).toMatchObject({ model: 'bge-m3', dimensions: null, ready: false });
		expect(indexProgress(ACCT)).toEqual({ total: 2, done: 0, failed: 0, pending: 2 });
		expect(getDb().prepare('SELECT COUNT(*) AS n FROM search_vectors').get()).toEqual({ n: 0 });
	});

	it('drops what a relisting didn’t see', () => {
		upsertEmails(ACCT, [{ id: 'new', receivedAt: '2026-01-01T00:00:00Z', mailboxIds: ['IN'] }], 1);
		expect(removeUnseen(ACCT, 1)).toEqual(['old']);
		expect(indexProgress(ACCT).total).toBe(1);
	});

	it('deletes the whole index when switched off', () => {
		storeVectors(ACCT, 'new', [quantize(unit(1, 0))]);
		setIndexEnabled(ACCT, false);
		expect(getIndexState(ACCT)?.enabled).toBe(false);
		expect(indexProgress(ACCT).total).toBe(0);
		expect(getDb().prepare('SELECT COUNT(*) AS n FROM search_vectors').get()).toEqual({ n: 0 });
	});
});
