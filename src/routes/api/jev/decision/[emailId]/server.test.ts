import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'zajel-jev-decision-')), 'test.db');
vi.mock('$lib/server/log', () => ({ logEvent: vi.fn(), errorFields: (e: unknown) => ({ error: String(e) }) }));
vi.mock('$env/dynamic/private', () => ({ env: {} }));

import { getDb } from '$lib/server/db/index';
import { runMigrations } from '$lib/server/db/migrate';
import { enqueueEmails, recordCorrections, recordDecision } from '$lib/server/db/queries/jev-decisions';
import { markHandled, recordArrivals } from '$lib/server/mail-pipeline/arrivals';
import { createRule, deleteRule } from '$lib/server/rules/store';
import type { RuleDraft } from '$lib/types/rules';
import { GET } from './+server';

const A = 'acct-a';
const B = 'acct-b';

async function ask(emailId: string, tab: string | null = 'updates', accountId: string | null = A) {
	const url = new URL(`http://localhost/api/jev/decision/${emailId}${tab ? `?tab=${tab}` : ''}`);
	const res = await GET({
		params: { emailId },
		url,
		locals: { auth: accountId ? {} : null, activeAccountId: accountId }
	} as unknown as Parameters<typeof GET>[0]);
	return { status: res.status, body: (await res.json()) as { why: unknown; rules: string[]; decision: unknown } };
}

const NOW = Date.parse('2026-11-12T09:00:00Z');
/** A decision as the pass records it: queued, then answered. */
function decided(accountId: string, emailId: string, d: Partial<Parameters<typeof recordDecision>[2]>) {
	enqueueEmails(accountId, [emailId], NOW);
	recordDecision(accountId, emailId, { category: null, confidence: null, applied: null, answers: {}, facts: {}, model: 'jev-model', inputTokens: 1, ...d }, NOW);
}
const draft = (name: string): RuleDraft => ({
	name,
	enabled: true,
	logic: 'allof',
	conditions: [{ id: 'c', field: 'from', op: 'contains', value: 'shop', negate: false }],
	target: { kind: 'label', mailboxId: 'L1' },
	markRead: false,
	star: false,
	stop: false
});
/** The arrival of a message, handled with the rules that matched it. */
function arrived(accountId: string, emailId: string, ruleIds: string[]) {
	recordArrivals(accountId, [{ emailId, mailbox: 'inbox', receivedAt: '2026-11-12T08:59:00Z' }], new Date(NOW));
	markHandled(accountId, [{ emailId, rules: ruleIds }], [], new Date(NOW));
}

beforeAll(() => {
	runMigrations();
	getDb().exec(`
		INSERT INTO app_user (id, email, password_hash) VALUES ('u1', 'u1@example.test', 'x');
		INSERT INTO mail_accounts (id, user_id, email, server_url, jmap_account_id, secret_enc) VALUES
			('${A}', 'u1', 'a@example.test', 'https://mail.example', 'j1', 'x'),
			('${B}', 'u1', 'b@example.test', 'https://mail.example', 'j2', 'x');
	`);
});

beforeEach(() => {
	for (const table of ['jev_decisions', 'mail_arrivals', 'rules']) getDb().prepare(`DELETE FROM ${table}`).run();
});

describe('GET /api/jev/decision/[emailId]: why a message is in its tab', () => {
	it('says you chose it, when you moved it to the tab it is in', async () => {
		decided(A, 'm1', { category: 'promotions', confidence: 0.7, applied: 'promotions' });
		recordCorrections(A, ['m1'], 'updates', NOW);
		expect((await ask('m1')).body.why).toEqual({ kind: 'chosen' });
		// Chosen before Jev ever saw it: the record is the choice alone.
		recordCorrections(A, ['m2'], 'updates', NOW);
		expect((await ask('m2')).body.why).toEqual({ kind: 'chosen' });
	});

	it('names the pin that put it there', async () => {
		decided(A, 'm1', { category: 'updates', applied: 'updates', pinnedBy: 'news@example.com', model: null });
		expect((await ask('m1')).body.why).toEqual({ kind: 'pin', sender: 'news@example.com' });
	});

	it('says how sure Jev was when Jev put it there', async () => {
		decided(A, 'm1', { category: 'updates', confidence: 0.92, applied: 'updates' });
		expect((await ask('m1')).body.why).toEqual({ kind: 'jev', confidence: 0.92 });
	});

	it('says only which tab, for a record about another tab than the one it is in now', async () => {
		decided(A, 'm1', { category: 'updates', confidence: 0.92, applied: 'updates' });
		expect((await ask('m1', 'promotions')).body.why).toEqual({ kind: 'none' });
		decided(A, 'm2', { category: 'updates', applied: 'updates', pinnedBy: '@shop.example' });
		expect((await ask('m2', 'newsletters')).body.why).toEqual({ kind: 'none' });
		// Moved by you to one tab, now in another: your choice is older than that.
		decided(A, 'm3', { category: 'updates', confidence: 0.9, applied: 'updates' });
		recordCorrections(A, ['m3'], 'promotions', NOW);
		expect((await ask('m3', 'updates')).body.why).toEqual({ kind: 'none' });
		// Jev answered but its pick wasn't applied (you had moved it meanwhile).
		decided(A, 'm4', { category: 'updates', confidence: 0.9, applied: null });
		expect((await ask('m4')).body.why).toEqual({ kind: 'none' });
		// A tab that wasn't Jev's pick, with no pin or choice of yours to explain it.
		decided(A, 'm6', { category: 'promotions', confidence: 0.9, applied: 'updates' });
		expect((await ask('m6')).body.why).toEqual({ kind: 'none' });
		// Still queued, or never seen.
		enqueueEmails(A, ['m5'], NOW);
		expect((await ask('m5')).body.why).toEqual({ kind: 'none' });
		expect((await ask('never-seen')).body).toEqual({ decision: null, why: { kind: 'none' }, rules: [] });
	});

	it('has no reason without a tab to give it for', async () => {
		decided(A, 'm1', { category: 'updates', confidence: 0.92, applied: 'updates' });
		expect((await ask('m1', null)).body.why).toBeNull();
		expect((await ask('m1', 'social')).body.why).toBeNull();
	});

	it('names the rules that matched it on arrival, in their order, leaving out a deleted one', async () => {
		const receipts = createRule(A, draft('Receipts'), NOW);
		const shop = createRule(A, draft('Shop'), NOW);
		const gone = createRule(A, draft('Gone'), NOW);
		arrived(A, 'm1', [shop.id, gone.id, receipts.id]);
		deleteRule(A, gone.id);
		expect((await ask('m1')).body.rules).toEqual(['Receipts', 'Shop']);
		// None recorded (mail older than a week, or no rule matched).
		arrived(A, 'm2', []);
		expect((await ask('m2')).body.rules).toEqual([]);
	});

	it('finds nothing of another account’s message under the account in use', async () => {
		decided(B, 'mb', { category: 'updates', confidence: 0.99, applied: 'updates' });
		arrived(B, 'mb', [createRule(B, draft('Theirs'), NOW).id]);
		expect((await ask('mb', 'updates', A)).body).toEqual({ decision: null, why: { kind: 'none' }, rules: [] });
		expect((await ask('mb', 'updates', B)).body).toMatchObject({ why: { kind: 'jev', confidence: 0.99 }, rules: ['Theirs'] });
	});

	it('requires sign-in', async () => {
		expect((await ask('m1', 'updates', null)).status).toBe(401);
	});
});
