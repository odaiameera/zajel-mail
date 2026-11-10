import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Point the lazy SQLite singleton at a throwaway file before anything opens it.
process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'ameera-jevworker-')), 'test.db');

const env = vi.hoisted(() => ({}) as Record<string, string | undefined>);
vi.mock('$env/dynamic/private', () => ({ env }));

const jmap = vi.hoisted(() => ({ client: null as unknown }));
// A session with an address book, so "is the sender a contact" gets a real
// answer (the fake holds no cards) rather than "couldn't tell".
vi.mock('$lib/jmap/auth', () => ({
	createClient: () => jmap.client,
	fetchSession: () =>
		Promise.resolve({
			capabilities: { 'urn:ietf:params:jmap:contacts': {} },
			primaryAccounts: { 'urn:ietf:params:jmap:contacts': 'jmap-acc' },
			accounts: { 'jmap-acc': { accountCapabilities: { 'urn:ietf:params:jmap:contacts': {} } } }
		})
}));

// `notify` records each email queued for an alert, as notifyUrgent once did.
const telegram = vi.hoisted(() => ({ wanted: false, notify: vi.fn(), flush: vi.fn(async () => {}) }));
vi.mock('$lib/server/telegram/notifier', () => ({
	urgentAlertsWanted: () => telegram.wanted,
	queueUrgent: (account: string, email: unknown) => {
		telegram.notify(account, email);
		return 'user-1';
	},
	flushAlerts: telegram.flush
}));
// Whether something is urgent is Jev's call; here every judged email is.
vi.mock('$lib/server/telegram/urgent', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/telegram/urgent')>()),
	isUrgent: () => true
}));

import { getDb } from '$lib/server/db/index';
import { runMigrations } from '$lib/server/db/migrate';
import { getJevSettings, updateJevSettings } from '$lib/server/db/queries/jev-settings';
import { enqueueEmails, getDecision, getUsage, recordCorrections } from '$lib/server/db/queries/jev-decisions';
import { setRules } from '$lib/server/db/queries/rules';
import { recordSenderMoves, setPin } from '$lib/server/db/queries/jev-learning';
import type { AuthState, MethodCall } from '$lib/jmap/types';
import type { Rule } from '$lib/types/rules';
import { forgetRateLimits, sortNewMail, sortNewMailSafe } from './worker';
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
							{ id: 'junk', name: 'Junk', role: 'junk', sortOrder: 4, parentId: null },
							{ id: 'trash', name: 'Trash', role: 'trash', sortOrder: 5, parentId: null }
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
					// Copies, as a server sends: what was read doesn't follow later changes.
					result = { list: ids.map((id) => this.emails.get(id)).filter(Boolean).map((e) => structuredClone(e)) };
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
	forgetRateLimits();
	// Off and on again, so every test's cursor starts at T0.
	updateJevSettings(ACCT, { jevEnabled: false });
	updateJevSettings(ACCT, { inboxTabs: true, jevEnabled: true, spamMode: 'off' }, T0);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

/** A live answer from TypeSafe: Newsletters, confidently. */
const liveAnswer = () =>
	new Response(
		JSON.stringify({
			model: 'jev-1.13.0',
			answers: { category: { type: 'choice', choice: 'newsletters', probabilities: { newsletters: 0.9 }, confidence: 0.8 } },
			usage: { input_tokens: 10, output_tokens: 2 }
		}),
		{ status: 200 }
	);

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
		// A minute back from the pass, so mail landing later in its last second is read again.
		expect(getJevSettings(ACCT).sortCursor).toBe(at(9).toISOString());
		// Mock answers cost nothing and aren't counted.
		expect(getUsage(ACCT).requests).toBe(0);
	});

	it('moves on past a full page of mail stamped with the same second', async () => {
		// A bulk import: 100 messages, one receivedAt.
		for (let i = 0; i < 100; i += 1) fake.add(`bulk-${i}`, 5);
		await sortNewMail(ACCT, ME, auth, at(10));
		await sortNewMail(ACCT, ME, auth, at(11));
		// Stepping back a second for ties would land on the same cursor forever.
		expect(getJevSettings(ACCT).sortCursor).toBe(at(5).toISOString());
		await sortNewMail(ACCT, ME, auth, at(12));
		expect(getJevSettings(ACCT).sortCursor).toBe(at(11).toISOString());
	});

	it('does nothing while the tabs are off', async () => {
		updateJevSettings(ACCT, { inboxTabs: false });
		fake.add('news', 1, { 'header:list-unsubscribe': ' <x>' });
		await sortNewMail(ACCT, ME, auth, at(10));
		expect(getDecision(ACCT, 'news')).toBeNull();
	});

	it('charges an attempt to an email that fails while others are answered', async () => {
		delete env.JEV_MOCK;
		env.TYPESAFE_API_KEY = 'ts-test-key';
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const answer = () =>
			new Response(
				JSON.stringify({
					model: 'jev-1.13.0',
					answers: { category: { type: 'choice', choice: 'newsletters', probabilities: { newsletters: 0.9 }, confidence: 0.8 } },
					usage: { input_tokens: 10, output_tokens: 2 }
				}),
				{ status: 200 }
			);
		// Every try for 'a' fails; 'b' is answered.
		vi.stubGlobal(
			'fetch',
			vi.fn().mockImplementation(async (_url: string, init?: RequestInit) =>
				String(init?.body).includes('fail-me') ? new Response('{}', { status: 500 }) : answer()
			)
		);
		fake.add('a', 1, { 'header:list-unsubscribe': ' <x>', subject: 'fail-me' });
		fake.add('b', 2, { 'header:list-unsubscribe': ' <x>', subject: 'fine' });

		await sortNewMail(ACCT, ME, auth, at(10));
		expect(getDecision(ACCT, 'a')).toMatchObject({ status: 'pending', attempts: 1 });
		expect(getDecision(ACCT, 'b')?.status).toBe('done');
	});

	it('retries an email when TypeSafe fails, and counts live usage when it answers', async () => {
		delete env.JEV_MOCK;
		env.TYPESAFE_API_KEY = 'ts-test-key';
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 500 }));
		vi.stubGlobal('fetch', fetchMock);
		fake.add('news', 1, { 'header:list-unsubscribe': ' <x>' });

		await sortNewMail(ACCT, ME, auth, at(10));
		// Every email asked failed: TypeSafe is down, so nothing is charged
		// against the email; it is simply asked again next pass.
		expect(getDecision(ACCT, 'news')).toMatchObject({ status: 'pending', attempts: 0 });
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

	it('does not write over a move or a tab change made while Jev was judging', async () => {
		const invoices: Rule = {
			id: 'invoices',
			name: 'Invoices',
			enabled: true,
			logic: 'allof',
			conditions: [{ id: 'j1', field: 'jev', op: 'contains', value: 'an invoice', negate: false }],
			actions: [{ type: 'applyLabel', value: 'archive' }],
			createdAt: 0
		};
		setRules(ME, [invoices]);
		fake.add('news', 1, { 'header:list-unsubscribe': ' <x>' });
		fake.add('bill', 2, { subject: 'Your October invoice' });
		fake.add('deal', 3, { 'header:list-unsubscribe': ' <x>', subject: '30% off this week' });
		// Between Jev's read of the messages and its write: you drag the
		// newsletter to Promotions, delete the invoice and star the offer.
		const realRequest = fake.request.bind(fake);
		let meanwhile = false;
		fake.request = async (calls: MethodCall[]) => {
			const result = await realRequest(calls);
			if (!meanwhile && calls[0][0] === 'Email/get' && (calls[0][1].properties as string[]).includes('textBody')) {
				meanwhile = true;
				fake.emails.get('news')!.keywords = { $cat_promotions: true };
				fake.emails.get('bill')!.mailboxIds = { trash: true };
				fake.emails.get('deal')!.keywords = { $flagged: true };
			}
			return result;
		};

		await sortNewMail(ACCT, ME, auth, at(10));

		// Your tab stands, and Jev's is not added beside it.
		expect(fake.emails.get('news')!.keywords).toEqual({ $cat_promotions: true });
		expect(getDecision(ACCT, 'news')).toMatchObject({ status: 'done', category: 'newsletters', applied: null });
		// Deleted mail stays deleted: the label is not written from the old snapshot.
		expect(fake.emails.get('bill')!.mailboxIds).toEqual({ trash: true });
		expect(getDecision(ACCT, 'bill')?.status).toBe('done');
		// A change that is not a move is kept, and Jev's tab still goes on.
		expect(fake.emails.get('deal')!.keywords).toEqual({ $flagged: true, $cat_promotions: true });
	});

	it('keeps the mail server’s reason when it refuses the tab, and tries again', async () => {
		fake.add('news', 1, { 'header:list-unsubscribe': ' <x>' });
		const realRequest = fake.request.bind(fake);
		let refuse = true;
		fake.request = async (calls: MethodCall[]) => {
			if (refuse && calls[0][0] === 'Email/set') {
				const ids = Object.keys(calls[0][1].update as Record<string, unknown>);
				const notUpdated = Object.fromEntries(
					ids.map((id) => [id, { type: 'invalidPatch', description: 'Invalid patch value', properties: ['keywords'] }])
				);
				return { methodResponses: [['Email/set', { updated: {}, notUpdated }, '0']], sessionState: '' };
			}
			return realRequest(calls);
		};

		await sortNewMail(ACCT, ME, auth, at(10));
		// Nothing was written, nothing claims it was, and the server's words
		// are kept: a bare "refused" can't tell a bad patch from a gone message.
		expect(fake.emails.get('news')!.keywords).toEqual({});
		expect(getDecision(ACCT, 'news')).toMatchObject({ status: 'pending', attempts: 1, applied: null });
		expect(getDecision(ACCT, 'news')?.lastError).toBe(
			'The mail server refused the change: invalidPatch: Invalid patch value (keywords)'
		);

		// The next pass asks again and, accepted this time, puts it in its tab.
		refuse = false;
		await sortNewMail(ACCT, ME, auth, at(11));
		expect(fake.emails.get('news')!.keywords).toEqual({ $cat_newsletters: true });
		expect(getDecision(ACCT, 'news')).toMatchObject({ status: 'done', applied: 'newsletters', lastError: null });
	});

	it('leaves mail you put in Important yourself where it is', async () => {
		fake.add('news', 1, { 'header:list-unsubscribe': ' <x>' });
		enqueueEmails(ACCT, ['news'], at(1).getTime());
		// Dragged to Updates and back to Important before Jev got to it.
		recordCorrections(ACCT, ['news'], 'important');

		await sortNewMail(ACCT, ME, auth, at(10));

		expect(fake.emails.get('news')!.keywords).toEqual({});
		expect(getDecision(ACCT, 'news')).toMatchObject({ status: 'done', applied: null, correctedTo: 'important', model: null });
	});

	it('gives up on a message TypeSafe refuses, even when it is the only one asked', async () => {
		delete env.JEV_MOCK;
		env.TYPESAFE_API_KEY = 'ts-test-key';
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"error":"state too large"}', { status: 400 })));
		fake.add('huge', 1, { 'header:list-unsubscribe': ' <x>' });

		await sortNewMail(ACCT, ME, auth, at(10));
		// A refusal is about this request, not an outage: it counts against the email.
		expect(getDecision(ACCT, 'huge')).toMatchObject({ status: 'pending', attempts: 1 });
	});

	it('pauses an account for a while after TypeSafe rate-limits every call', async () => {
		delete env.JEV_MOCK;
		env.TYPESAFE_API_KEY = 'ts-test-key';
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const fetchMock = vi.fn().mockImplementation(async () => new Response('{}', { status: 429 }));
		vi.stubGlobal('fetch', fetchMock);
		fake.add('news', 1, { 'header:list-unsubscribe': ' <x>' });

		// The retries' backoff sleeps are skipped over.
		vi.useFakeTimers({ toFake: ['setTimeout'] });
		const first = sortNewMail(ACCT, ME, auth, at(10));
		await vi.advanceTimersByTimeAsync(5000);
		await first;
		vi.useRealTimers();
		expect(fetchMock).toHaveBeenCalledTimes(3); // the call and its two retries
		expect(getDecision(ACCT, 'news')).toMatchObject({ status: 'pending', attempts: 0 });

		// The next passes leave TypeSafe alone, while still queuing what arrives...
		fetchMock.mockClear();
		fake.add('later', 11, { 'header:list-unsubscribe': ' <x>' });
		await sortNewMail(ACCT, ME, auth, at(12));
		expect(fetchMock).not.toHaveBeenCalled();
		expect(getDecision(ACCT, 'later')?.status).toBe('pending');

		// ...and once the pause is over, it asks again.
		fetchMock.mockImplementation(async () => liveAnswer());
		await sortNewMail(ACCT, ME, auth, at(16));
		expect(getDecision(ACCT, 'news')?.status).toBe('done');
		expect(getDecision(ACCT, 'later')?.status).toBe('done');
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

	it('never lets a rule Jev judges move mail to Trash or Junk', async () => {
		const junkIt: Rule = {
			id: 'junkit',
			name: 'Junk invoices',
			enabled: true,
			logic: 'allof',
			conditions: [{ id: 'j1', field: 'jev', op: 'contains', value: 'an invoice', negate: false }],
			actions: [{ type: 'moveToFolder', value: 'junk' }, { type: 'markRead' }],
			createdAt: 0
		};
		setRules(ME, [junkIt]);
		fake.add('bill', 1, { subject: 'Your October invoice' });

		await sortNewMail(ACCT, ME, auth, at(10));

		// The move is dropped, as Delete is; the rest of the rule still runs.
		expect(fake.emails.get('bill')!.mailboxIds).toEqual({ inbox: true });
		expect(fake.emails.get('bill')!.keywords).toEqual({ $seen: true });
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

	it('sends no origin evidence with existing mail, whose spam is not checked', async () => {
		updateJevSettings(ACCT, { spamMode: 'active' });
		fake.add('old', -60, { 'header:list-unsubscribe': ' <x>' });
		enqueueEmails(ACCT, ['old'], T0.getTime(), true);
		fake.add('fresh', 1, { 'header:list-unsubscribe': ' <x>' });

		await sortNewMail(ACCT, ME, auth, at(10));

		expect(getDecision(ACCT, 'fresh')?.facts).toHaveProperty('security');
		expect(getDecision(ACCT, 'old')?.facts).not.toHaveProperty('security');
	});

	describe('urgent mail on Telegram', () => {
		beforeEach(() => {
			telegram.wanted = false;
			telegram.notify.mockClear();
		});

		it('alerts for new Inbox mail only while alerts are wanted', async () => {
			fake.add('alarm', 1, { subject: 'Server down' });
			await sortNewMail(ACCT, ME, auth, at(10));
			expect(telegram.notify).not.toHaveBeenCalled();

			telegram.wanted = true;
			fake.add('pager', 11, { subject: 'Database unreachable' });
			await sortNewMail(ACCT, ME, auth, at(20));
			expect(telegram.notify).toHaveBeenCalledTimes(1);
			expect(telegram.notify).toHaveBeenCalledWith(ACCT, expect.objectContaining({ id: 'pager' }));
		});

		it('asks Jev even when nothing else needs asking', async () => {
			updateJevSettings(ACCT, { inboxTabs: false });
			telegram.wanted = true;
			fake.add('only', 1, { subject: 'Your flight was cancelled' });
			await sortNewMail(ACCT, ME, auth, at(10));
			expect(telegram.notify).toHaveBeenCalledWith(ACCT, expect.objectContaining({ id: 'only' }));
		});
	});

	describe('switching Jev off', () => {
		const MONTH = 30 * 24 * 60;

		it('withdraws what was queued, so switching it back on sends only new mail', async () => {
			fake.add('oldNews', -60, { 'header:list-unsubscribe': ' <x>' });
			fake.add('arrived', 1, { 'header:list-unsubscribe': ' <x>' });
			enqueueEmails(ACCT, ['oldNews'], T0.getTime(), true); // a backfill under way
			enqueueEmails(ACCT, ['arrived'], at(1).getTime()); // a new arrival not yet judged
			updateJevSettings(ACCT, { jevEnabled: false }, at(2));

			// A month later, switched on again for new mail.
			updateJevSettings(ACCT, { jevEnabled: true }, at(MONTH));
			fake.add('fresh', MONTH + 1, { 'header:list-unsubscribe': ' <x>' });
			await sortNewMail(ACCT, ME, auth, at(MONTH + 10));

			expect(getDecision(ACCT, 'oldNews')?.status).toBe('skipped');
			expect(getDecision(ACCT, 'arrived')?.status).toBe('skipped');
			expect(fake.emails.get('oldNews')!.keywords).toEqual({});
			expect(fake.emails.get('arrived')!.keywords).toEqual({});
			expect(getDecision(ACCT, 'fresh')).toMatchObject({ status: 'done', applied: 'newsletters' });
		});

		it('stops a pass that is already running', async () => {
			fake.add('news', 1, { 'header:list-unsubscribe': ' <x>' });
			// Switched off just after the pass queued what had arrived.
			const request = fake.request.bind(fake);
			let switched = false;
			fake.request = async (calls) => {
				const result = await request(calls);
				if (!switched && calls.some(([name]) => name === 'Email/query')) {
					switched = true;
					updateJevSettings(ACCT, { jevEnabled: false }, at(5));
				}
				return result;
			};

			await sortNewMail(ACCT, ME, auth, at(10));
			expect(fake.emails.get('news')!.keywords).toEqual({});
			expect(getDecision(ACCT, 'news')?.status).not.toBe('done');

			// Nor does it go out once Jev is back on.
			updateJevSettings(ACCT, { jevEnabled: true }, at(MONTH));
			await sortNewMail(ACCT, ME, auth, at(MONTH + 10));
			expect(fake.emails.get('news')!.keywords).toEqual({});
			expect(getDecision(ACCT, 'news')?.status).toBe('skipped');
			expect(getJevSettings(ACCT).sortCursor).toBe(at(MONTH + 9).toISOString());
		});
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

		it('in active mode, only warns when it couldn’t check whether you know the sender', async () => {
			updateJevSettings(ACCT, { spamMode: 'active' });
			fake.add('phish', 1, lookalike);
			// The Sent lookup fails this pass, so "have you written to them" is unknown.
			const realRequest = fake.request.bind(fake);
			fake.request = async (calls: MethodCall[]) => {
				if (calls.some(([name, args]) => name === 'Email/query' && !!(args.filter as { to?: string }).to)) {
					throw new Error('Sent is unavailable');
				}
				return realRequest(calls);
			};

			await sortNewMail(ACCT, ME, auth, at(10));

			expect(fake.emails.get('phish')!.mailboxIds).toEqual({ inbox: true });
			expect(getDecision(ACCT, 'phish')).toMatchObject({ spamAction: 'flagged' });
			expect(getDecision(ACCT, 'phish')?.facts).toMatchObject({ you_have_written_to_sender: null });
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

describe('the Inbox’s hold on new mail', () => {
	// Thirty seconds before the pass: still young enough for the Inbox to hold.
	const JUST_NOW = 9.5;
	const SORTED = '$jev_sorted';

	it('marks new mail done whatever Jev made of it, so the Inbox shows it in its tab at once', async () => {
		fake.add('news', JUST_NOW, { 'header:list-unsubscribe': ' <x>', subject: 'Issue 212' });
		fake.add('person', JUST_NOW, { from: [{ name: 'Sam', email: 'sam@example.com' }] });
		// You put this in a tab before Jev got to it: Jev isn't even asked.
		fake.add('yours', JUST_NOW, { keywords: { $cat_updates: true } });
		setPin(ACCT, '@linkedin.com', 'updates');
		fake.add('pinned', JUST_NOW, { from: [{ name: 'LinkedIn', email: 'jobs@linkedin.com' }] });

		await sortNewMail(ACCT, ME, auth, at(10));

		expect(fake.emails.get('news')!.keywords).toEqual({ $cat_newsletters: true, [SORTED]: true });
		// Staying in Important is an outcome too: the hold lets it go now.
		expect(fake.emails.get('person')!.keywords).toEqual({ [SORTED]: true });
		expect(fake.emails.get('yours')!.keywords).toEqual({ $cat_updates: true, [SORTED]: true });
		expect(fake.emails.get('pinned')!.keywords).toEqual({ $cat_updates: true, [SORTED]: true });
	});

	it('leaves mail unmarked while Jev hasn’t answered, so the hold’s own timeout lets it through', async () => {
		delete env.JEV_MOCK;
		env.TYPESAFE_API_KEY = 'ts-test-key';
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 500 })));
		fake.add('news', JUST_NOW, { 'header:list-unsubscribe': ' <x>' });

		await sortNewMail(ACCT, ME, auth, at(10));

		expect(fake.emails.get('news')!.keywords).toEqual({});
		expect(getDecision(ACCT, 'news')?.status).toBe('pending');
	});

	it('spends no write on mail too old to be held', async () => {
		fake.add('person', 1, { from: [{ name: 'Sam', email: 'sam@example.com' }] });
		const sets: MethodCall[] = [];
		const realRequest = fake.request.bind(fake);
		fake.request = async (calls: MethodCall[]) => {
			sets.push(...calls.filter(([name]) => name === 'Email/set'));
			return realRequest(calls);
		};

		await sortNewMail(ACCT, ME, auth, at(10));

		expect(fake.emails.get('person')!.keywords).toEqual({});
		expect(sets).toEqual([]);
	});

	it('marks mail put in another tab while Jev was judging, without writing over your tab', async () => {
		fake.add('news', JUST_NOW, { 'header:list-unsubscribe': ' <x>' });
		const realRequest = fake.request.bind(fake);
		let meanwhile = false;
		fake.request = async (calls: MethodCall[]) => {
			const result = await realRequest(calls);
			if (!meanwhile && calls[0][0] === 'Email/get' && (calls[0][1].properties as string[]).includes('textBody')) {
				meanwhile = true;
				fake.emails.get('news')!.keywords = { $cat_promotions: true };
			}
			return result;
		};

		await sortNewMail(ACCT, ME, auth, at(10));

		expect(fake.emails.get('news')!.keywords).toEqual({ $cat_promotions: true, [SORTED]: true });
		expect(getDecision(ACCT, 'news')).toMatchObject({ status: 'done', applied: null });
	});

	it('marks mail brought back from Junk, but not mail it sends there', async () => {
		updateJevSettings(ACCT, { spamMode: 'active' });
		fake.add('toFriend', -100, { mailboxIds: { sent: true }, to: [{ name: null, email: 'friend@pal.example' }] });
		fake.add('spammy', JUST_NOW, { 'header:x-spam-status:asText': 'Yes, score=8.1', subject: 'Cheap watches' });
		fake.add('wronglyJunked', JUST_NOW, {
			mailboxIds: { junk: true },
			subject: 'Your receipt',
			'header:authentication-results:asText:all': ['mx.example.test; spf=pass; dkim=pass; dmarc=pass']
		});

		await sortNewMail(ACCT, ME, auth, at(10));

		expect(fake.emails.get('spammy')!.mailboxIds).toEqual({ junk: true });
		expect(fake.emails.get('spammy')!.keywords).toEqual({});
		expect(fake.emails.get('wronglyJunked')!.mailboxIds).toEqual({ inbox: true });
		expect(fake.emails.get('wronglyJunked')!.keywords).toEqual({ [SORTED]: true });
	});

	it('writes no mark while the Inbox has no tabs, as nothing is held then', async () => {
		updateJevSettings(ACCT, { inboxTabs: false, spamMode: 'watch' });
		fake.add('person', JUST_NOW, { from: [{ name: 'Sam', email: 'sam@example.com' }] });

		await sortNewMail(ACCT, ME, auth, at(10));

		expect(getDecision(ACCT, 'person')?.status).toBe('done');
		expect(fake.emails.get('person')!.keywords).toEqual({});
	});

	it('runs a pass asked for while one is running once it ends, so new mail isn’t left to the next minute', async () => {
		fake.add('first', JUST_NOW, { from: [{ name: 'Sam', email: 'sam@example.com' }] });
		const realRequest = fake.request.bind(fake);
		let second: Promise<void> | null = null;
		fake.request = async (calls: MethodCall[]) => {
			// Mail lands, and its push asks for a pass, while the first pass is judging.
			if (!second && calls[0][0] === 'Email/get' && (calls[0][1].properties as string[]).includes('textBody')) {
				fake.add('second', JUST_NOW + 0.1, { from: [{ name: 'Ana', email: 'ana@example.com' }] });
				second = sortNewMailSafe(ACCT, ME, auth);
			}
			return realRequest(calls);
		};
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(at(10));

		await sortNewMailSafe(ACCT, ME, auth);
		await second;

		expect(getDecision(ACCT, 'first')?.status).toBe('done');
		expect(getDecision(ACCT, 'second')?.status).toBe('done');
	});
});
