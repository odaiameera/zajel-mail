import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Point the lazy SQLite singleton at a throwaway file before anything opens it.
process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'ameera-jevworker-')), 'test.db');

const env = vi.hoisted(() => ({}) as Record<string, string | undefined>);
vi.mock('$env/dynamic/private', () => ({ env }));

const jmap = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('$lib/jmap/auth', () => ({
	createClient: () => jmap.client,
	fetchSession: () => Promise.reject(new Error('no session in tests'))
}));

import { getDb } from '$lib/server/db/index';
import { runMigrations } from '$lib/server/db/migrate';
import { getJevSettings, updateJevSettings } from '$lib/server/db/queries/jev-settings';
import { enqueueEmails, getDecision, getUsage } from '$lib/server/db/queries/jev-decisions';
import { setRules } from '$lib/server/db/queries/rules';
import { recordSenderMoves, setPin } from '$lib/server/db/queries/jev-learning';
import type { AuthState, MethodCall } from '$lib/jmap/types';
import type { Rule } from '$lib/types/rules';
import { sortNewMail } from './worker';
import { jevHandlesRules } from './rules';

const ACCT = 'acct-1';
const ME = 'me@example.test';
const auth = { authHeader: 'Basic x', accountId: 'jmap-acc', apiUrl: 'https://mail.example/jmap/', sessionState: '' } as AuthState;
const T0 = new Date('2026-10-18T09:00:00Z');
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

interface FakeEmail {
	id: string;
	threadId: string;
	mailboxIds: Record<string, boolean>;
	keywords: Record<string, boolean>;
	from: { name: string | null; email: string }[];
	to: { name: string | null; email: string }[];
	cc: null;
	subject: string;
	receivedAt: string;
	preview: string;
	'header:list-unsubscribe'?: string;
	'header:x-spam-status:asText'?: string;
	'header:authentication-results:asText:all'?: string[];
}

/** Just enough JMAP for a sorting pass, over an in-memory mailbox. */
class FakeJmap {
	emails = new Map<string, FakeEmail>();

	add(id: string, minutes: number, extra: Partial<FakeEmail> = {}) {
		this.emails.set(id, {
			id,
			threadId: `t-${id}`,
			mailboxIds: { inbox: true },
			keywords: {},
			from: [{ name: null, email: 'someone@example.com' }],
			to: [{ name: null, email: ME }],
			cc: null,
			subject: 'Hello',
			receivedAt: at(minutes).toISOString(),
			preview: '',
			...extra
		});
	}

	async request(calls: MethodCall[]) {
		const done: [string, Record<string, unknown>, string][] = [];
		const resolve = (args: Record<string, unknown>) => {
			const ref = args['#ids'] as { resultOf: string; path: string } | undefined;
			if (!ref) return args.ids as string[] | null;
			const result = done.find((d) => d[2] === ref.resultOf)![1];
			if (ref.path === '/ids') return result.ids as string[];
			return (result.list as { emailIds: string[] }[]).flatMap((t) => t.emailIds);
		};
		for (const [name, args, tag] of calls) {
			let result: Record<string, unknown>;
			switch (name) {
				case 'Mailbox/get':
					result = {
						list: [
							{ id: 'inbox', name: 'Inbox', role: 'inbox', sortOrder: 1, parentId: null },
							{ id: 'sent', name: 'Sent', role: 'sent', sortOrder: 2, parentId: null },
							{ id: 'archive', name: 'Archive', role: 'archive', sortOrder: 3, parentId: null },
							{ id: 'junk', name: 'Junk', role: 'junk', sortOrder: 4, parentId: null }
						]
					};
					break;
				case 'Email/query': {
					const f = args.filter as { operator?: string; conditions?: Record<string, string>[] } & Record<string, string>;
					const conds = f.operator ? f.conditions! : [f];
					const ids = [...this.emails.values()]
						.filter((e) =>
							conds.every(
								(c) =>
									(!c.inMailbox || e.mailboxIds[c.inMailbox]) &&
									(!c.after || e.receivedAt > c.after) &&
									(!c.to || e.to.some((a) => a.email === c.to))
							)
						)
						.sort((a, b) => a.receivedAt.localeCompare(b.receivedAt))
						.map((e) => e.id);
					result = { ids, total: ids.length };
					break;
				}
				case 'Email/get': {
					const ids = resolve(args) ?? [];
					result = { list: ids.map((id) => this.emails.get(id)).filter(Boolean) };
					break;
				}
				case 'Thread/get':
					result = { list: (args.ids as string[]).map((id) => ({ id, emailIds: [] })) };
					break;
				case 'Email/set': {
					for (const [id, patch] of Object.entries(args.update as Record<string, Record<string, unknown>>)) {
						const e = this.emails.get(id)!;
						for (const [key, on] of Object.entries(patch)) {
							if (key === 'mailboxIds') {
								e.mailboxIds = { ...(on as Record<string, boolean>) };
								continue;
							}
							const keyword = key.replace('keywords/', '');
							if (on) e.keywords[keyword] = true;
							else delete e.keywords[keyword];
						}
					}
					result = { updated: {} };
					break;
				}
				default:
					result = {};
			}
			done.push([name, result, tag]);
		}
		return { methodResponses: done, sessionState: '' };
	}
}

let fake: FakeJmap;

beforeAll(() => {
	runMigrations();
	getDb()
		.prepare(`INSERT INTO app_user (id, email, password_hash) VALUES ('user-1', 'u@example.test', 'x')`)
		.run();
	getDb()
		.prepare(
			`INSERT INTO mail_accounts (id, user_id, email, server_url, jmap_account_id, secret_enc)
			 VALUES (?, 'user-1', ?, 'https://mail.example', 'jmap-acc', 'x')`
		)
		.run(ACCT, ME);
});

beforeEach(() => {
	for (const key of Object.keys(env)) delete env[key];
	env.JEV_MOCK = '1';
	fake = new FakeJmap();
	jmap.client = fake;
	getDb().prepare('DELETE FROM jev_decisions').run();
	getDb().prepare('DELETE FROM jev_usage').run();
	setRules(ME, []);
	getDb().prepare('DELETE FROM jev_sender_pins').run();
	getDb().prepare('DELETE FROM jev_sender_moves').run();
	// Off and on again, so every test's cursor starts at T0.
	updateJevSettings(ACCT, { jevEnabled: false });
	updateJevSettings(ACCT, { inboxTabs: true, jevEnabled: true, spamMode: 'off' }, T0);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('sortNewMail', () => {
	it('starts the clock on its first run instead of sorting the backlog', async () => {
		updateJevSettings(ACCT, { jevEnabled: false });
		updateJevSettings(ACCT, { jevEnabled: true }, T0);
		getDb().prepare('UPDATE jev_settings SET sort_cursor = NULL').run();
		fake.add('old', -60, { 'header:list-unsubscribe': ' <x>' });

		await sortNewMail(ACCT, ME, auth, at(5));

		expect(getJevSettings(ACCT).sortCursor).toBe(at(5).toISOString());
		expect(fake.emails.get('old')!.keywords).toEqual({});
	});

	it('sorts what arrived since sorting was switched on, and nothing else', async () => {
		fake.add('old', -10, { 'header:list-unsubscribe': ' <x>' });
		fake.add('news', 1, { 'header:list-unsubscribe': ' <x>', subject: 'Issue 212' });
		fake.add('promo', 2, { 'header:list-unsubscribe': ' <x>', subject: '48 hours: 30% off' });
		fake.add('person', 3, { from: [{ name: 'Sam', email: 'sam@example.com' }] });
		// You moved this to Updates before Jev got to it: it stays there.
		fake.add('moved', 4, { 'header:list-unsubscribe': ' <x>', keywords: { $cat_updates: true } });

		await sortNewMail(ACCT, ME, auth, at(10));

		expect(fake.emails.get('old')!.keywords).toEqual({});
		expect(fake.emails.get('news')!.keywords).toEqual({ $cat_newsletters: true });
		expect(fake.emails.get('promo')!.keywords).toEqual({ $cat_promotions: true });
		expect(fake.emails.get('person')!.keywords).toEqual({});
		expect(fake.emails.get('moved')!.keywords).toEqual({ $cat_updates: true });

		expect(getDecision(ACCT, 'news')).toMatchObject({ status: 'done', category: 'newsletters', applied: 'newsletters', model: 'mock' });
		expect(getDecision(ACCT, 'person')).toMatchObject({ status: 'done', category: 'important', applied: 'important' });
		// Already in a tab: Jev isn't even asked, so nothing is spent on it.
		expect(getDecision(ACCT, 'moved')).toMatchObject({ status: 'done', category: null, applied: null, model: null });
		expect(getDecision(ACCT, 'old')).toBeNull();
		expect(getJevSettings(ACCT).sortCursor).toBe(at(10).toISOString());
		// Mock answers cost nothing and aren't counted.
		expect(getUsage(ACCT).requests).toBe(0);
	});

	it('does nothing while the tabs are off', async () => {
		updateJevSettings(ACCT, { inboxTabs: false });
		fake.add('news', 1, { 'header:list-unsubscribe': ' <x>' });
		await sortNewMail(ACCT, ME, auth, at(10));
		expect(getDecision(ACCT, 'news')).toBeNull();
	});

	it('retries an email when TypeSafe fails, and counts live usage when it answers', async () => {
		delete env.JEV_MOCK;
		env.TYPESAFE_API_KEY = 'ts-test-key';
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 500 }));
		vi.stubGlobal('fetch', fetchMock);
		fake.add('news', 1, { 'header:list-unsubscribe': ' <x>' });

		await sortNewMail(ACCT, ME, auth, at(10));
		expect(getDecision(ACCT, 'news')).toMatchObject({ status: 'pending', attempts: 1 });
		expect(fake.emails.get('news')!.keywords).toEqual({});

		fetchMock.mockResolvedValue(
			new Response(
				JSON.stringify({
					model: 'jev-1.13.0',
					answers: {
						category: {
							type: 'choice',
							choice: 'newsletters',
							probabilities: { important: 0.05, updates: 0.05, newsletters: 0.85, promotions: 0.05 },
							confidence: 0.8
						}
					},
					usage: { input_tokens: 750, output_tokens: 2 }
				}),
				{ status: 200 }
			)
		);
		await sortNewMail(ACCT, ME, auth, at(11));
		expect(getDecision(ACCT, 'news')).toMatchObject({ status: 'done', applied: 'newsletters', model: 'jev-1.13.0' });
		expect(fake.emails.get('news')!.keywords).toEqual({ $cat_newsletters: true });
		expect(getUsage(ACCT)).toEqual({ requests: 1, inputTokens: 750 });
	});

	it('skips mail that left the Inbox before Jev got to it', async () => {
		fake.add('gone', 1);
		const realRequest = fake.request.bind(fake);
		// Archived between being queued and being judged.
		let archived = false;
		fake.request = async (calls: MethodCall[]) => {
			if (!archived && calls[0][0] === 'Email/get' && (calls[0][1].ids as string[] | undefined)?.includes('gone')) {
				fake.emails.get('gone')!.mailboxIds = { archive: true };
				archived = true;
			}
			return realRequest(calls);
		};
		await sortNewMail(ACCT, ME, auth, at(10));
		expect(getDecision(ACCT, 'gone')?.status).toBe('skipped');
	});

	it('runs rules with Jev conditions, and the exact rules beside them, in the same pass', async () => {
		const invoices: Rule = {
			id: 'invoices',
			name: 'Invoices',
			enabled: true,
			logic: 'allof',
			conditions: [{ id: 'j1', field: 'jev', op: 'contains', value: 'an invoice or a payment request', negate: false }],
			actions: [{ type: 'moveToFolder', value: 'archive' }, { type: 'delete' }],
			createdAt: 0
		};
		const sam: Rule = {
			id: 'sam',
			name: 'Sam',
			enabled: true,
			logic: 'allof',
			conditions: [{ id: 'f1', field: 'from', op: 'contains', value: 'sam@example.com', negate: false }],
			actions: [{ type: 'markRead' }],
			createdAt: 0
		};
		setRules(ME, [invoices, sam]);
		// Tabs off: only the rules need Jev.
		updateJevSettings(ACCT, { inboxTabs: false });
		expect(jevHandlesRules(ACCT, [invoices, sam])).toBe(true);

		fake.add('bill', 1, { subject: 'Your October invoice' });
		fake.add('lunch', 2, { subject: 'Lunch?' });
		fake.add('fromSam', 3, { from: [{ name: 'Sam', email: 'sam@example.com' }] });

		await sortNewMail(ACCT, ME, auth, at(10));

		// Mock Jev: "invoice" is in the subject, so the statement holds (0.9).
		// The rule moves it — and its Delete is skipped, as for any Jev rule.
		expect(fake.emails.get('bill')!.mailboxIds).toEqual({ archive: true });
		expect(fake.emails.get('lunch')!.mailboxIds).toEqual({ inbox: true });
		expect(fake.emails.get('fromSam')!.keywords).toEqual({ $seen: true });

		expect(getDecision(ACCT, 'bill')?.rules).toEqual([
			{
				ruleId: 'invoices',
				ruleName: 'Invoices',
				statement: 'an invoice or a payment request',
				probability: 0.9,
				threshold: 0.8,
				negate: false,
				fired: true
			}
		]);
		expect(getDecision(ACCT, 'bill')?.category).toBeNull();
	});

	it('leaves rules to the rules scheduler while Jev may not read the account', () => {
		const jevRule: Rule = {
			id: 'r',
			name: 'r',
			enabled: true,
			logic: 'allof',
			conditions: [{ id: 'j', field: 'jev', op: 'contains', value: 'anything', negate: false }],
			actions: [],
			createdAt: 0
		};
		updateJevSettings(ACCT, { jevEnabled: false });
		expect(jevHandlesRules(ACCT, [jevRule])).toBe(false);
		updateJevSettings(ACCT, { jevEnabled: true });
		expect(jevHandlesRules(ACCT, [jevRule])).toBe(true);
		expect(jevHandlesRules(ACCT, [{ ...jevRule, conditions: [] }])).toBe(false);
	});

	it('puts a pinned sender’s mail in its tab without asking Jev', async () => {
		delete env.JEV_MOCK;
		env.TYPESAFE_API_KEY = 'ts-test-key';
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
		setPin(ACCT, '@linkedin.com', 'updates');
		fake.add('jobs', 1, { from: [{ name: 'LinkedIn', email: 'jobs@linkedin.com' }], subject: 'New jobs for you' });

		await sortNewMail(ACCT, ME, auth, at(10));

		expect(fetchMock).not.toHaveBeenCalled();
		expect(fake.emails.get('jobs')!.keywords).toEqual({ $cat_updates: true });
		expect(getDecision(ACCT, 'jobs')).toMatchObject({
			status: 'done',
			category: 'updates',
			applied: 'updates',
			pinnedBy: '@linkedin.com',
			model: null
		});
	});

	it('tells Jev where you have moved a sender’s mail before', async () => {
		recordSenderMoves(ACCT, ['deals@shop.example', 'deals@shop.example'], 'newsletters');
		// No list headers: on its own the mock would say Important.
		fake.add('deal', 1, { from: [{ name: 'Shop', email: 'deals@shop.example' }], subject: 'This week' });

		await sortNewMail(ACCT, ME, auth, at(10));

		const decision = getDecision(ACCT, 'deal');
		expect(decision?.facts).toMatchObject({
			sender_history: 'You have moved 2 earlier emails from this sender to Newsletters.'
		});
		// The mock follows your habit, as Jev is meant to.
		expect(decision?.applied).toBe('newsletters');
	});

	it('sorts mail already in the Inbox for its tab only, never running rules on it', async () => {
		const markAll: Rule = {
			id: 'all',
			name: 'Mark invoices read',
			enabled: true,
			logic: 'allof',
			conditions: [{ id: 'j1', field: 'jev', op: 'contains', value: 'an invoice', negate: false }],
			actions: [{ type: 'markRead' }],
			createdAt: 0
		};
		setRules(ME, [markAll]);
		// Older than the cursor: only a backfill reaches these.
		fake.add('oldNews', -60, { 'header:list-unsubscribe': ' <x>', subject: 'Your invoice digest' });
		fake.add('oldPinned', -50, { from: [{ name: 'Shop', email: 'deals@shop.example' }] });
		fake.add('oldSorted', -40, { keywords: { $cat_updates: true } });
		setPin(ACCT, '@shop.example', 'promotions');
		enqueueEmails(ACCT, ['oldNews', 'oldPinned', 'oldSorted'], T0.getTime(), true);

		await sortNewMail(ACCT, ME, auth, at(10));

		// Tab from Jev; the invoice rule did not run on old mail.
		expect(fake.emails.get('oldNews')!.keywords).toEqual({ $cat_newsletters: true });
		expect(getDecision(ACCT, 'oldNews')?.rules).toBeNull();
		// Pins apply to existing mail too.
		expect(fake.emails.get('oldPinned')!.keywords).toEqual({ $cat_promotions: true });
		// Already in a tab: left alone, and nothing asked.
		expect(fake.emails.get('oldSorted')!.keywords).toEqual({ $cat_updates: true });
		expect(getDecision(ACCT, 'oldSorted')).toMatchObject({ status: 'done', model: null });
	});

	describe('spam checks', () => {
		const flagged = { 'header:x-spam-status:asText': 'Yes, score=8.1' };
		const lookalike = {
			from: [{ name: 'PayPal.com', email: 'alerts@secure-pay.example' }],
			subject: 'Confirm your account'
		};

		beforeEach(() => {
			// Someone you've written to: a message to them sits in Sent.
			fake.add('toFriend', -100, { mailboxIds: { sent: true }, to: [{ name: null, email: 'friend@pal.example' }] });
		});

		it('records what active mode would do in watch mode, and moves nothing', async () => {
			updateJevSettings(ACCT, { spamMode: 'watch' });
			fake.add('spammy', 1, flagged);

			await sortNewMail(ACCT, ME, auth, at(10));

			expect(fake.emails.get('spammy')!.mailboxIds).toEqual({ inbox: true });
			expect(getDecision(ACCT, 'spammy')).toMatchObject({
				spam: 0.95,
				stalwartSpam: true,
				spamAction: 'would_junk'
			});
		});

		it('in active mode, sends strangers’ spam and phishing to Junk, and only warns about people you know', async () => {
			updateJevSettings(ACCT, { spamMode: 'active' });
			fake.add('spammy', 1, { ...flagged, subject: 'Cheap watches' });
			fake.add('phish', 2, lookalike);
			fake.add('friendPhish', 3, { ...lookalike, from: [{ name: 'PayPal.com', email: 'friend@pal.example' }] });

			await sortNewMail(ACCT, ME, auth, at(10));

			expect(fake.emails.get('spammy')!.mailboxIds).toEqual({ junk: true });
			expect(fake.emails.get('phish')!.mailboxIds).toEqual({ junk: true });
			expect(getDecision(ACCT, 'phish')).toMatchObject({ phishing: 0.92, spamAction: 'junked' });
			// Never Junk for someone you've written to: a warning instead.
			expect(fake.emails.get('friendPhish')!.mailboxIds).toEqual({ inbox: true });
			expect(getDecision(ACCT, 'friendPhish')?.spamAction).toBe('flagged');
			// Junked mail skips tabs and rules; no $junk keyword, so Stalwart isn't trained.
			expect(fake.emails.get('spammy')!.keywords).toEqual({});
		});

		it('in active mode, brings clean mail back from Junk and leaves real spam there', async () => {
			updateJevSettings(ACCT, { spamMode: 'active' });
			const dmarc = (result: string) => ({
				'header:authentication-results:asText:all': [`mx.example.test; spf=pass; dkim=pass; dmarc=${result}`]
			});
			fake.add('wronglyJunked', 1, { mailboxIds: { junk: true }, subject: 'Your receipt', ...dmarc('pass') });
			fake.add('realSpam', 2, { mailboxIds: { junk: true }, ...flagged, ...dmarc('pass') });
			// Looks clean to Jev, but nothing vouches for the sender's domain.
			fake.add('noDmarc', 3, { mailboxIds: { junk: true }, subject: 'Your receipt' });
			fake.add('dmarcError', 4, { mailboxIds: { junk: true }, subject: 'Your receipt', ...dmarc('temperror') });

			await sortNewMail(ACCT, ME, auth, at(10));

			expect(fake.emails.get('wronglyJunked')!.mailboxIds).toEqual({ inbox: true });
			expect(getDecision(ACCT, 'wronglyJunked')).toMatchObject({ stalwartSpam: true, spamAction: 'rescued' });
			expect(fake.emails.get('realSpam')!.mailboxIds).toEqual({ junk: true });
			expect(getDecision(ACCT, 'realSpam')?.spamAction).toBeNull();
			expect(fake.emails.get('noDmarc')!.mailboxIds).toEqual({ junk: true });
			expect(fake.emails.get('dmarcError')!.mailboxIds).toEqual({ junk: true });
		});

		it('leaves Junk alone while spam checks are off', async () => {
			fake.add('wronglyJunked', 1, { mailboxIds: { junk: true } });
			await sortNewMail(ACCT, ME, auth, at(10));
			expect(getDecision(ACCT, 'wronglyJunked')).toBeNull();
		});
	});
});
