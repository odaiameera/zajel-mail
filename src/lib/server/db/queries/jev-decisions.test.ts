import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { beforeAll, describe, expect, it } from 'vitest';

// Point the lazy SQLite singleton at a throwaway file before anything opens it.
process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'ameera-jevdec-')), 'test.db');

import { getDb } from '../index';
import { runMigrations } from '../migrate';
import {
	addUsage,
	backfillProgress,
	cancelBackfill,
	correctedEmailIds,
	decisionStats,
	enqueueEmails,
	getDecision,
	getUsage,
	knownEmailIds,
	listPendingEmailIds,
	markSkipped,
	MAX_JEV_ATTEMPTS,
	recordCorrections,
	recordDecision,
	recordFailure,
	recordSpamCorrections,
	spamRows
} from './jev-decisions';

const ACCT = 'acct-1';

beforeAll(() => {
	runMigrations();
	getDb()
		.prepare(`INSERT INTO app_user (id, email, password_hash) VALUES ('user-1', 'me@example.test', 'x')`)
		.run();
	getDb()
		.prepare(
			`INSERT INTO mail_accounts (id, user_id, email, server_url, jmap_account_id, secret_enc)
			 VALUES (?, 'user-1', 'a@example.test', 'https://mail.example', 'jmap', 'x')`
		)
		.run(ACCT);
});

const answer = {
	category: 'updates' as const,
	confidence: 0.8,
	applied: 'updates' as const,
	answers: { category: { type: 'choice', choice: 'updates', probabilities: { updates: 0.85 } } },
	facts: { has_list_unsubscribe: false },
	model: 'jev-1.13.0',
	inputTokens: 900
};

describe('jev decisions', () => {
	it('queues each email once and hands them out oldest first', () => {
		enqueueEmails(ACCT, ['e2'], 2000);
		enqueueEmails(ACCT, ['e1', 'e2'], 1000);
		// e2 keeps its first queue time; e1 was queued earlier.
		expect(listPendingEmailIds(ACCT, 10)).toEqual(['e1', 'e2']);
		expect(listPendingEmailIds(ACCT, 1)).toEqual(['e1']);
	});

	it('records an answer without any email text', () => {
		recordDecision(ACCT, 'e1', answer, 3000);
		const row = getDecision(ACCT, 'e1');
		expect(row).toMatchObject({ status: 'done', category: 'updates', applied: 'updates', inputTokens: 900 });
		expect(row?.answers).toEqual(answer.answers);
		expect(listPendingEmailIds(ACCT, 10)).toEqual(['e2']);
	});

	it('retries a failing email, then gives up', () => {
		for (let i = 1; i < MAX_JEV_ATTEMPTS; i++) {
			recordFailure(ACCT, 'e2', 'TypeSafe returned an error (502)');
			expect(getDecision(ACCT, 'e2')).toMatchObject({ status: 'pending', attempts: i });
		}
		recordFailure(ACCT, 'e2', 'TypeSafe returned an error (502)');
		expect(getDecision(ACCT, 'e2')).toMatchObject({ status: 'failed', attempts: MAX_JEV_ATTEMPTS });
		expect(listPendingEmailIds(ACCT, 10)).toEqual([]);
	});

	it('marks mail that left the Inbox first as skipped', () => {
		enqueueEmails(ACCT, ['e3']);
		markSkipped(ACCT, 'e3');
		expect(getDecision(ACCT, 'e3')?.status).toBe('skipped');
	});

	it('counts a move away from where Jev put it as a correction', () => {
		enqueueEmails(ACCT, ['e4', 'e5'], 1000);
		recordDecision(ACCT, 'e4', answer, 4000);
		recordDecision(ACCT, 'e5', { ...answer, applied: null }, 4000);

		recordCorrections(ACCT, ['e1'], 'promotions'); // Jev said Updates: corrected
		recordCorrections(ACCT, ['e4'], 'updates'); // moved back where Jev had it: not
		recordCorrections(ACCT, ['e5'], 'important'); // left in Important, kept there: not
		recordCorrections(ACCT, ['e2'], 'important'); // never answered: your choice is kept all the same

		expect(getDecision(ACCT, 'e1')?.correctedTo).toBe('promotions');
		expect(getDecision(ACCT, 'e2')).toMatchObject({ status: 'failed', correctedTo: 'important' });
		expect(decisionStats(ACCT, 0)).toEqual({ sorted: 3, corrected: 1 });
		expect(decisionStats(ACCT, 3500)).toEqual({ sorted: 2, corrected: 0 });
	});

	it('remembers a tab you chose for mail Jev never saw, so it is never sorted', () => {
		recordCorrections(ACCT, ['mine'], 'important', 4500);
		expect(getDecision(ACCT, 'mine')).toMatchObject({
			status: 'done',
			category: null,
			applied: null,
			correctedTo: 'important',
			model: null
		});
		// Known to the backfill, and marked as your choice for the worker...
		expect(knownEmailIds(ACCT, ['mine', 'e3'])).toEqual(new Set(['mine']));
		expect(correctedEmailIds(ACCT, ['mine', 'e3', 'never-seen'])).toEqual(new Set(['mine']));
		// ...but not Jev's doing, so neither sorted nor corrected in the stats.
		expect(decisionStats(ACCT, 4400)).toEqual({ sorted: 0, corrected: 0 });

		// Sorted by you before the pass queued it, it is still queued as new mail
		// (for spam, rules and urgency), keeping your choice; once judged, never again.
		expect(enqueueEmails(ACCT, ['mine'], 4600)).toBe(1);
		expect(getDecision(ACCT, 'mine')).toMatchObject({ status: 'pending', correctedTo: 'important' });
		recordDecision(ACCT, 'mine', { ...answer, category: null, confidence: null, applied: null, model: null }, 4700);
		expect(enqueueEmails(ACCT, ['mine'], 4800)).toBe(0);
		expect(getDecision(ACCT, 'mine')).toMatchObject({ status: 'done', correctedTo: 'important' });
	});

	it('adds up usage per calendar month', () => {
		const oct = new Date('2026-10-05T00:00:00Z');
		addUsage(ACCT, 1000, oct);
		addUsage(ACCT, 500, oct);
		addUsage(ACCT, 70, new Date('2026-11-01T00:00:00Z'));
		expect(getUsage(ACCT, '2026-10')).toEqual({ requests: 2, inputTokens: 1500 });
		expect(getUsage(ACCT, '2026-11')).toEqual({ requests: 1, inputTokens: 70 });
		expect(getUsage(ACCT, '2026-09')).toEqual({ requests: 0, inputTokens: 0 });
	});

	it('keeps existing mail in its own queue, in the order given, and can cancel it', () => {
		const queued = enqueueEmails(ACCT, ['b-new', 'b-mid', 'b-old', 'e1'], 5000, true);
		expect(queued).toBe(3); // e1 is already known
		expect(listPendingEmailIds(ACCT, 10, true)).toEqual(['b-new', 'b-mid', 'b-old']);
		expect(listPendingEmailIds(ACCT, 10)).not.toContain('b-new');

		recordDecision(ACCT, 'b-new', answer);
		expect(backfillProgress(ACCT)).toEqual({ pending: 2, done: 1, failed: 0, skipped: 0 });

		cancelBackfill(ACCT);
		expect(backfillProgress(ACCT)).toEqual({ pending: 0, done: 1, failed: 0, skipped: 2 });
		expect(listPendingEmailIds(ACCT, 10, true)).toEqual([]);
	});

	it('knows judged and queued mail, but offers skipped and failed mail again', () => {
		// b-old was cancelled above; it is still unsorted, so it is not "known".
		expect([...knownEmailIds(ACCT, ['e1', 'b-new', 'b-old', 'never-seen'])].sort()).toEqual(['b-new', 'e1']);
		expect(knownEmailIds(ACCT, []).size).toBe(0);

		// A message that failed for good is offered again too, with a fresh start.
		enqueueEmails(ACCT, ['b-dead'], 6000, true);
		for (let i = 0; i < MAX_JEV_ATTEMPTS; i++) recordFailure(ACCT, 'b-dead', 'boom');
		expect(getDecision(ACCT, 'b-dead')?.status).toBe('failed');
		expect(knownEmailIds(ACCT, ['b-dead']).size).toBe(0);

		// Starting a run again queues the skipped and failed rows, not the judged one.
		const requeued = enqueueEmails(ACCT, ['b-new', 'b-mid', 'b-old', 'b-dead'], 7000, true);
		expect(requeued).toBe(3);
		expect(listPendingEmailIds(ACCT, 10, true)).toEqual(['b-mid', 'b-old', 'b-dead']);
		expect(getDecision(ACCT, 'b-dead')).toMatchObject({ status: 'pending', attempts: 0, lastError: null });
		expect(getDecision(ACCT, 'b-new')?.status).toBe('done');

		// New arrivals never revive a row: that queue is driven by the cursor.
		cancelBackfill(ACCT);
		expect(enqueueEmails(ACCT, ['b-old'], 8000)).toBe(0);
		expect(getDecision(ACCT, 'b-old')?.status).toBe('skipped');
	});

	it('keeps spam verdicts, and your Spam / Not spam clicks against them', () => {
		enqueueEmails(ACCT, ['s1', 's2']);
		const spamAnswer = { ...answer, spam: { spam: 0.95, phishing: 0.1, stalwartSpam: false, action: 'would_junk' } };
		recordDecision(ACCT, 's1', spamAnswer, 9000);
		recordDecision(ACCT, 's2', answer, 9000); // no spam check
		recordSpamCorrections(ACCT, ['s1', 's2'], 'ham');

		expect(getDecision(ACCT, 's1')).toMatchObject({
			spam: 0.95,
			phishing: 0.1,
			stalwartSpam: false,
			spamAction: 'would_junk',
			spamCorrectedTo: 'ham'
		});
		expect(getDecision(ACCT, 's2')).toMatchObject({ spam: null, spamCorrectedTo: null });
		expect(spamRows(ACCT, 8000)).toEqual([
			{ emailId: 's1', spam: 0.95, phishing: 0.1, stalwartSpam: false, action: 'would_junk', correctedTo: 'ham' }
		]);
	});
});
