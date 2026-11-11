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

// The event log, kept in memory: what the worker says about failing passes.
const log = vi.hoisted(() => ({ events: [] as { level: string; event: string; fields: Record<string, unknown> }[] }));
vi.mock('$lib/server/log', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/log')>()),
	logEvent: (level: string, _area: string, event: string, fields: Record<string, unknown> = {}) => {
		log.events.push({ level, event, fields });
	}
}));
const logged = (prefix: string) => log.events.filter((e) => e.event.startsWith(prefix)).map((e) => e.event);

import { getDb } from '$lib/server/db/index';
import { runMigrations } from '$lib/server/db/migrate';
import { getJevSettings, updateJevSettings } from '$lib/server/db/queries/jev-settings';
import { enqueueEmails, getDecision, getUsage, recordCorrections } from '$lib/server/db/queries/jev-decisions';
import { setRulesCursor } from '$lib/server/db/queries/rules';
import { importRules } from '$lib/server/rules/store';
import { applyRulesForUser } from '$lib/server/rules-scheduler';
import { INBOX_HOLD_MS, isHeld } from '$lib/inbox-hold';
import { recordSenderMoves, setPin } from '$lib/server/db/queries/jev-learning';
import type { AuthState, MethodCall } from '$lib/jmap/types';
import type { Rule } from '$lib/types/rules';
import { forgetRateLimits, sortNewMail, sortNewMailSafe } from './worker';

const ACCT = 'acct-1';
const ME = 'me@example.test';
const auth = { authHeader: 'Basic x', accountId: 'jmap-acc', apiUrl: 'https://mail.example/jmap/', sessionState: '' } as AuthState;
const T0 = new Date('2026-10-18T09:00:00Z');

/** The account's rules, replaced. */
function setRules(_email: string, rules: Rule[]): void {
	getDb().prepare('DELETE FROM rules WHERE account_id = ?').run(ACCT);
	importRules(ACCT, rules);
}
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
	/** Mailbox/get calls answered. */
	mailboxGets = 0;
	/** Mailboxes made after the first Mailbox/get: every later one lists them. */
	madeLater: { id: string; name: string; role: null; sortOrder: number; parentId: string | null }[] = [];

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
							{ id: 'trash', name: 'Trash', role: 'trash', sortOrder: 5, parentId: null },
							{ id: 'labels', name: 'Labels', role: null, sortOrder: 6, parentId: null },
							{ id: 'news', name: 'News', role: null, sortOrder: 0, parentId: 'labels' },
							...(this.mailboxGets > 0 ? this.madeLater : [])
						]
					};
					this.mailboxGets++;
					break;
				case 'Email/query': {
					const f = args.filter as { operator?: string; conditions?: Record<string, string>[] } & Record<string, string>;
					const conds = f.operator ? f.conditions! : [f];
					const matching = [...this.emails.values()]
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
					// A page at a time, as a server answers; the total is of every match.
					const ids = matching.slice(0, typeof args.limit === 'number' ? args.limit : undefined);
					result = { ids, total: matching.length };
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
	log.events = [];
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
		fake.add('news', 1, { 'header:list-unsubscribe': ' <x>' });
		fake.add('bill', 2, { 'header:list-unsubscribe': ' <x>', subject: 'Your October invoice' });
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
		// Deleted mail stays deleted, and is not given a tab from the old snapshot.
		expect(fake.emails.get('bill')!.mailboxIds).toEqual({ trash: true });
		expect(fake.emails.get('bill')!.keywords).toEqual({});
		expect(getDecision(ACCT, 'bill')).toMatchObject({ status: 'done', applied: null });
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

	it('logs a refusal once while it lasts, even as other writes succeed, and once when it ends', async () => {
		fake.add('bad', 1, { 'header:list-unsubscribe': ' <x>' });
		const realRequest = fake.request.bind(fake);
		let refuse = true;
		fake.request = async (calls: MethodCall[]) => {
			const [name, args] = calls[0];
			const update = args.update as Record<string, unknown> | undefined;
			if (refuse && name === 'Email/set' && update?.bad) {
				delete update.bad;
				const result = await realRequest(calls);
				(result.methodResponses[0][1] as Record<string, unknown>).notUpdated = { bad: { type: 'forbidden', description: 'Mailbox is read-only' } };
				return result;
			}
			return realRequest(calls);
		};

		// Each pass also sorts one existing message, which is written fine.
		for (let pass = 0; pass < 3; pass++) {
			fake.add(`old${pass}`, -60 - pass, { 'header:list-unsubscribe': ' <x>' });
			enqueueEmails(ACCT, [`old${pass}`], T0.getTime(), true);
			await sortNewMail(ACCT, ME, auth, at(10 + pass));
		}
		expect(fake.emails.get('old2')!.keywords).toEqual({ $cat_newsletters: true });
		expect(logged('write_')).toEqual(['write_refused']);
		expect(log.events.find((e) => e.event === 'write_refused')?.fields).toMatchObject({
			count: 1,
			error: 'forbidden: Mailbox is read-only'
		});

		refuse = false;
		await sortNewMail(ACCT, ME, auth, at(13));
		expect(fake.emails.get('bad')!.keywords).toEqual({ $cat_newsletters: true });
		expect(logged('write_')).toEqual(['write_refused', 'write_recovered']);
	});

	it('records a write that got no answer as unreached, not as refused', async () => {
		fake.add('news', 1, { 'header:list-unsubscribe': ' <x>' });
		const realRequest = fake.request.bind(fake);
		fake.request = async (calls: MethodCall[]) => {
			if (calls[0][0] === 'Email/set') throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
			return realRequest(calls);
		};

		await sortNewMail(ACCT, ME, auth, at(10));
		expect(getDecision(ACCT, 'news')).toMatchObject({
			status: 'pending',
			attempts: 1,
			lastError: 'Couldn’t reach the mail server: The operation was aborted due to timeout'
		});
		expect(logged('write_')).toEqual(['write_failed']);
		expect(log.events[log.events.length - 1].fields).toMatchObject({ errorType: 'TimeoutError' });
	});

	it('reads a refusal of any shape without losing the messages written beside it', async () => {
		fake.add('odd', 1, { 'header:list-unsubscribe': ' <x>' });
		fake.add('fine', 2, { 'header:list-unsubscribe': ' <x>' });
		const realRequest = fake.request.bind(fake);
		fake.request = async (calls: MethodCall[]) => {
			const update = calls[0][1].update as Record<string, unknown> | undefined;
			if (calls[0][0] === 'Email/set' && update?.odd) {
				delete update.odd;
				const result = await realRequest(calls);
				// Not what RFC 8620 says a SetError looks like: properties as a
				// string, and a description far too long to log whole.
				(result.methodResponses[0][1] as Record<string, unknown>).notUpdated = {
					odd: { type: 'invalidProperties', description: 'x'.repeat(5000), properties: 'keywords' }
				};
				return result;
			}
			return realRequest(calls);
		};

		await sortNewMail(ACCT, ME, auth, at(10));
		expect(getDecision(ACCT, 'fine')).toMatchObject({ status: 'done', applied: 'newsletters' });
		expect(getDecision(ACCT, 'odd')).toMatchObject({ status: 'pending', attempts: 1 });
		expect(getDecision(ACCT, 'odd')?.lastError).toMatch(/^The mail server refused the change: invalidProperties: x+$/);
		expect(String(log.events.find((e) => e.event === 'write_refused')?.fields.error).length).toBeLessThanOrEqual(300);
	});

	it('charges and records a request TypeSafe refuses for every email, instead of resending it for ever', async () => {
		delete env.JEV_MOCK;
		env.TYPESAFE_API_KEY = 'ts-test-key';
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		// TypeSafe says no to these two requests, and answers any other.
		vi.stubGlobal(
			'fetch',
			vi.fn().mockImplementation(async (_url: string, init?: RequestInit) =>
				String(init?.body).includes('Invoice') ? new Response('{"error":"bad question"}', { status: 400 }) : liveAnswer()
			)
		);
		fake.add('a', 1, { subject: 'Invoice 1' });
		fake.add('b', 2, { subject: 'Invoice 2' });

		await sortNewMail(ACCT, ME, auth, at(10));
		for (const id of ['a', 'b']) {
			expect(getDecision(ACCT, id)).toMatchObject({ status: 'pending', attempts: 1, lastError: 'TypeSafe returned an error (400)' });
		}
		// Given up on after its attempts, so the queue moves on.
		for (let pass = 1; pass < 5; pass++) await sortNewMail(ACCT, ME, auth, at(10 + pass));
		expect(getDecision(ACCT, 'a')).toMatchObject({ status: 'failed', attempts: 5 });
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
			conditions: [{ id: 's1', field: 'subject', op: 'contains', value: 'invoice', negate: false }],
			target: { kind: 'none' },
			markRead: true,
			star: false,
			stop: false,
			position: 0,
			createdAt: 0,
			updatedAt: 0
		};
		setRules(ME, [markAll]);
		setRulesCursor(ME, at(0).toISOString());
		// Older than the cursor: only a backfill reaches these.
		fake.add('oldNews', -60, { 'header:list-unsubscribe': ' <x>', subject: 'Your invoice digest' });
		fake.add('oldPinned', -50, { from: [{ name: 'Shop', email: 'deals@shop.example' }] });
		fake.add('oldSorted', -40, { keywords: { $cat_updates: true } });
		setPin(ACCT, '@shop.example', 'promotions');
		enqueueEmails(ACCT, ['oldNews', 'oldPinned', 'oldSorted'], T0.getTime(), true);

		await sortNewMail(ACCT, ME, auth, at(10));

		// Tab from Jev; the invoice rule did not run on old mail.
		expect(fake.emails.get('oldNews')!.keywords).toEqual({ $cat_newsletters: true });
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
			// Junked mail gets no tab; no $junk keyword, so Stalwart isn't trained.
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

		it('moves to Junk and back like any other move: labels stay on', async () => {
			updateJevSettings(ACCT, { spamMode: 'active' });
			fake.add('spammy', 1, { ...flagged, mailboxIds: { inbox: true, news: true } });
			fake.add('wronglyJunked', 2, {
				mailboxIds: { junk: true, news: true },
				'header:authentication-results:asText:all': ['mx.example.test; spf=pass; dkim=pass; dmarc=pass']
			});

			await sortNewMail(ACCT, ME, auth, at(10));

			expect(fake.emails.get('spammy')!.mailboxIds).toEqual({ junk: true, news: true });
			expect(fake.emails.get('wronglyJunked')!.mailboxIds).toEqual({ inbox: true, news: true });
		});

		it('keeps a label made during the pass on a move to Junk and back, fetching the folders again once', async () => {
			updateJevSettings(ACCT, { spamMode: 'active' });
			// Made, and put on these messages, after the pass loaded its folder list.
			fake.madeLater = [
				{ id: 'newlbl', name: 'Fresh', role: null, sortOrder: 0, parentId: 'labels' },
				{ id: 'newdir', name: 'Fresh folder', role: null, sortOrder: 0, parentId: null }
			];
			fake.add('spammy', 1, { ...flagged, mailboxIds: { inbox: true, news: true, newlbl: true } });
			fake.add('wronglyJunked', 2, {
				mailboxIds: { junk: true, newlbl: true, newdir: true },
				'header:authentication-results:asText:all': ['mx.example.test; spf=pass; dkim=pass; dmarc=pass']
			});

			await sortNewMail(ACCT, ME, auth, at(10));

			expect(fake.emails.get('spammy')!.mailboxIds).toEqual({ junk: true, news: true, newlbl: true });
			// The fresh list knows the new folder: the move leaves it, as any move leaves every folder.
			expect(fake.emails.get('wronglyJunked')!.mailboxIds).toEqual({ inbox: true, newlbl: true });
			expect(fake.mailboxGets).toBe(2);
		});

		it('fetches the folders only once in a pass whose mail is all in folders it knows', async () => {
			updateJevSettings(ACCT, { spamMode: 'active' });
			fake.add('spammy', 1, { ...flagged, mailboxIds: { inbox: true, news: true } });

			await sortNewMail(ACCT, ME, auth, at(10));

			expect(fake.emails.get('spammy')!.mailboxIds).toEqual({ junk: true, news: true });
			expect(fake.mailboxGets).toBe(1);
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

describe('the Inbox’s hold, with rules and the push stream', () => {
	const JUST_NOW = 9.5;
	const SORTED = '$jev_sorted';
	// "Archive" stands in for a label: the rule adds a mailbox and leaves the Inbox.
	const labelGithub: Rule = {
		id: 'gh',
		name: 'Label GitHub',
		enabled: true,
		logic: 'allof',
		conditions: [{ id: 'c1', field: 'from', op: 'contains', value: 'github.com', negate: false }],
		target: { kind: 'label', mailboxId: 'archive' },
		markRead: false,
		star: false,
		stop: false,
		position: 0,
		createdAt: 0,
		updatedAt: 0
	};

	it('lets exact rules act before it marks new mail, so a rule’s label is there when the message shows', async () => {
		setRules(ME, [labelGithub]);
		setRulesCursor(ME, at(0).toISOString());
		fake.add('gh', JUST_NOW, { from: [{ name: 'GitHub', email: 'noreply@github.com' }], 'header:list-unsubscribe': ' <x>' });
		// The order of the writes: the label has to be on before the mark is.
		const inOrder: Record<string, unknown>[] = [];
		const watched = fake.request.bind(fake);
		fake.request = async (calls: MethodCall[]) => {
			for (const [name, args] of calls) {
				if (name === 'Email/set') inOrder.push((args.update as Record<string, Record<string, unknown>>).gh);
			}
			return watched(calls);
		};

		await sortNewMail(ACCT, ME, auth, at(10));

		expect(fake.emails.get('gh')!.mailboxIds).toEqual({ inbox: true, archive: true });
		expect(fake.emails.get('gh')!.keywords).toEqual({ $cat_newsletters: true, [SORTED]: true });
		expect(inOrder).toEqual([
			{ mailboxIds: { inbox: true, archive: true } },
			{ 'keywords/$cat_newsletters': true, [`keywords/${SORTED}`]: true }
		]);
		fake.request = watched;
		// The rules scheduler's own run afterwards finds nothing left to do.
		const writes: MethodCall[] = [];
		const realRequest = fake.request.bind(fake);
		fake.request = async (calls: MethodCall[]) => {
			writes.push(...calls.filter(([name]) => name === 'Email/set'));
			return realRequest(calls);
		};
		await applyRulesForUser(auth, ME);
		expect(writes).toEqual([]);
	});

	it('keeps exact rules working while TypeSafe is down', async () => {
		delete env.JEV_MOCK;
		env.TYPESAFE_API_KEY = 'ts-test-key';
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 500 })));
		setRules(ME, [labelGithub]);
		setRulesCursor(ME, at(0).toISOString());
		fake.add('gh', JUST_NOW, { from: [{ name: 'GitHub', email: 'noreply@github.com' }] });

		await sortNewMail(ACCT, ME, auth, at(10));

		// The rule's label is on; no mark, so the hold's timeout lets it through.
		expect(fake.emails.get('gh')!.mailboxIds).toEqual({ inbox: true, archive: true });
		expect(fake.emails.get('gh')!.keywords).toEqual({});
	});

	it('runs rules first with the tabs off too, so a rule’s move lands before a spam verdict could take the message', async () => {
		updateJevSettings(ACCT, { inboxTabs: false, spamMode: 'active' });
		const githubToArchive: Rule = { ...labelGithub, id: 'gh-move', target: { kind: 'folder', mailboxId: 'archive' } };
		setRules(ME, [githubToArchive]);
		setRulesCursor(ME, at(0).toISOString());
		// Stalwart flagged it, and nobody here knows the sender: Jev would junk it.
		// (Its own id: the scheduler remembers the ids its last run handled.)
		fake.add('ghMoved', JUST_NOW, { from: [{ name: 'GitHub', email: 'noreply@github.com' }], 'header:x-spam-status:asText': 'Yes, score=8.1' });
		fake.add('spammy', JUST_NOW, { 'header:x-spam-status:asText': 'Yes, score=8.1' });

		await sortNewMail(ACCT, ME, auth, at(10));

		// The rule got there first; Jev never saw the message in the Inbox.
		expect(fake.emails.get('ghMoved')!.mailboxIds).toEqual({ archive: true });
		expect(getDecision(ACCT, 'ghMoved')).toBeNull();
		// The check that would have taken it is real: this one went to Junk.
		expect(fake.emails.get('spammy')!.mailboxIds).toEqual({ junk: true });
	});

	it('runs no rule that is waiting to be rewritten, even switched back on', async () => {
		// What the upgrade leaves of a rule with a Jev condition: flagged, its
		// exact part in place. Someone has switched it on again unfixed.
		const flagged: Rule = {
			...labelGithub,
			id: 'flagged',
			target: { kind: 'folder', mailboxId: 'archive' },
			attention: 'jev_condition',
			enabled: true
		};
		setRules(ME, [flagged]);
		setRulesCursor(ME, at(0).toISOString());
		fake.add('ghFlagged', JUST_NOW, { from: [{ name: 'GitHub', email: 'noreply@github.com' }] });

		await sortNewMail(ACCT, ME, auth, at(10));
		await applyRulesForUser(auth, ME);

		expect(fake.emails.get('ghFlagged')!.mailboxIds).toEqual({ inbox: true });
	});

	it('leaves mail judged while the tabs were off unmarked: it waits out the hold, no longer', async () => {
		updateJevSettings(ACCT, { inboxTabs: false, spamMode: 'watch' });
		fake.add('p', JUST_NOW, { from: [{ name: 'Sam', email: 'sam@example.com' }] });
		await sortNewMail(ACCT, ME, auth, at(10));
		updateJevSettings(ACCT, { inboxTabs: true });
		await sortNewMail(ACCT, ME, auth, at(10.1));

		const email = fake.emails.get('p')!;
		expect(email.keywords[SORTED]).toBeUndefined();
		expect(isHeld(email, at(10.1).getTime())).toBe(true);
		expect(isHeld(email, at(JUST_NOW).getTime() + INBOX_HOLD_MS + 1000)).toBe(false);
	});

	it('judges new mail only on a pass the stream asked for, leaving the backlog to the scheduled run', async () => {
		fake.add('old', -60, { 'header:list-unsubscribe': ' <x>' });
		enqueueEmails(ACCT, ['old'], T0.getTime(), true);
		fake.add('news', JUST_NOW, { 'header:list-unsubscribe': ' <x>' });
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(at(10));

		await sortNewMailSafe(ACCT, ME, auth, { fromStream: true });
		expect(getDecision(ACCT, 'news')?.status).toBe('done');
		expect(getDecision(ACCT, 'old')?.status).toBe('pending');

		await sortNewMailSafe(ACCT, ME, auth);
		expect(getDecision(ACCT, 'old')?.status).toBe('done');
	});

	it('stops calling TypeSafe on every change while it is down, until the next scheduled pass', async () => {
		delete env.JEV_MOCK;
		env.TYPESAFE_API_KEY = 'ts-test-key';
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 500 }));
		vi.stubGlobal('fetch', fetchMock);
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(at(10));
		fake.add('a', JUST_NOW, { 'header:list-unsubscribe': ' <x>' });

		await sortNewMailSafe(ACCT, ME, auth);
		expect(fetchMock).toHaveBeenCalled();

		// Mail lands, and its change asks for a pass: TypeSafe is left alone.
		fetchMock.mockClear();
		fake.add('b', JUST_NOW + 0.2, { 'header:list-unsubscribe': ' <x>' });
		await sortNewMailSafe(ACCT, ME, auth, { fromStream: true });
		expect(fetchMock).not.toHaveBeenCalled();

		// The scheduled pass tries again, and once TypeSafe answers, the
		// stream's passes do too.
		fetchMock.mockImplementation(async () => liveAnswer());
		await sortNewMailSafe(ACCT, ME, auth);
		expect(getDecision(ACCT, 'b')?.status).toBe('done');
		fake.add('c', JUST_NOW + 0.3, { 'header:list-unsubscribe': ' <x>' });
		await sortNewMailSafe(ACCT, ME, auth, { fromStream: true });
		expect(getDecision(ACCT, 'c')?.status).toBe('done');
	});

	it('doesn’t chain a pass onto every write of the backlog when driven by the stream', async () => {
		const { startJevWatchers, stopJevWatchers } = await import('./stream');
		const accounts = await import('$lib/server/auth/accounts');
		vi.spyOn(accounts, 'listSchedulableAuths').mockReturnValue([{ account: { id: ACCT, email: ME } as never, auth, email: ME }]);
		const ids = Array.from({ length: 300 }, (_, i) => `old${i}`);
		ids.forEach((id, i) => fake.add(id, -60 + i * 0.01, { 'header:list-unsubscribe': ' <x>' }));
		enqueueEmails(ACCT, ids, T0.getTime(), true);
		let push!: (text: string) => void;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				push = (text) => controller.enqueue(new TextEncoder().encode(text));
			}
		});
		vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200 })));
		// Every write is an Email change, which the stream reports.
		const realRequest = fake.request.bind(fake);
		fake.request = async (calls: MethodCall[]) => {
			const result = await realRequest(calls);
			if (calls.some(([name]) => name === 'Email/set')) push('event: state\ndata: {}\n\n');
			return result;
		};

		startJevWatchers(sortNewMailSafe);
		await new Promise((resolve) => setTimeout(resolve, 3500));
		stopJevWatchers();

		expect(ids.filter((id) => getDecision(ACCT, id)?.status === 'done')).toEqual([]);
	}, 10_000);
});

describe('sender pins, with Jev off or out of reach', () => {
	const JUST_NOW = 9.5;
	const SORTED = '$jev_sorted';
	const linkedIn = { from: [{ name: 'LinkedIn', email: 'jobs@linkedin.com' }], subject: 'New jobs for you' };
	const sam = { from: [{ name: 'Sam', email: 'sam@example.com' }] };
	/** Every call the pass makes to TypeSafe; none is answered. */
	const noTypeSafe = () => {
		const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 500 }));
		vi.stubGlobal('fetch', fetchMock);
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		return fetchMock;
	};

	it('puts a pinned sender’s new mail in its tab and marks it, with Jev switched off for the account', async () => {
		const fetchMock = noTypeSafe();
		updateJevSettings(ACCT, { jevEnabled: false });
		setPin(ACCT, '@linkedin.com', 'updates');
		fake.add('jobs', JUST_NOW, linkedIn);
		fake.add('person', JUST_NOW, sam);

		await sortNewMail(ACCT, ME, auth, at(10));

		expect(fake.emails.get('jobs')!.keywords).toEqual({ $cat_updates: true, [SORTED]: true });
		expect(getDecision(ACCT, 'jobs')).toMatchObject({
			status: 'done',
			category: 'updates',
			applied: 'updates',
			pinnedBy: '@linkedin.com',
			model: null
		});
		// Mail nobody pinned is let through where it is: marked, so the Inbox
		// stops holding it, and not counted as sorted, so "sort the mail
		// already in your Inbox" can still offer it once Jev is on.
		expect(fake.emails.get('person')!.keywords).toEqual({ [SORTED]: true });
		expect(getDecision(ACCT, 'person')).toMatchObject({ status: 'skipped', category: null, model: null });
		// Nothing was asked of TypeSafe, and nothing counted as used.
		expect(fetchMock).not.toHaveBeenCalled();
		expect(getUsage(ACCT)).toEqual({ requests: 0, inputTokens: 0 });
	});

	it('does the same while Jev isn’t configured on the server at all', async () => {
		delete env.JEV_MOCK; // no key, no mock: jevMode() is 'off'
		const fetchMock = noTypeSafe();
		setPin(ACCT, 'jobs@linkedin.com', 'promotions');
		fake.add('jobs', JUST_NOW, linkedIn);

		await sortNewMail(ACCT, ME, auth, at(10));

		expect(fake.emails.get('jobs')!.keywords).toEqual({ $cat_promotions: true, [SORTED]: true });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('does nothing with Jev off when there are no pins, or no tabs', async () => {
		updateJevSettings(ACCT, { jevEnabled: false });
		fake.add('jobs', JUST_NOW, linkedIn);
		const requests: MethodCall[][] = [];
		const realRequest = fake.request.bind(fake);
		fake.request = async (calls: MethodCall[]) => {
			requests.push(calls);
			return realRequest(calls);
		};

		// No pins: nothing would sort this Inbox, so nothing is read or held.
		await sortNewMail(ACCT, ME, auth, at(10));
		// Pins, but no tabs to put mail in.
		setPin(ACCT, '@linkedin.com', 'updates');
		updateJevSettings(ACCT, { inboxTabs: false });
		await sortNewMail(ACCT, ME, auth, at(10));

		expect(requests).toEqual([]);
		expect(fake.emails.get('jobs')!.keywords).toEqual({});
		expect(getJevSettings(ACCT).sortCursor).toBeNull();
	});

	it('starts with the mail the Inbox may be holding, and leaves older mail alone', async () => {
		updateJevSettings(ACCT, { jevEnabled: false });
		setPin(ACCT, '@linkedin.com', 'updates');
		fake.add('old', 5, linkedIn); // five minutes before the pass: never held
		fake.add('held', JUST_NOW, linkedIn);

		await sortNewMail(ACCT, ME, auth, at(10));

		expect(fake.emails.get('old')!.keywords).toEqual({});
		expect(getDecision(ACCT, 'old')).toBeNull();
		expect(fake.emails.get('held')!.keywords).toEqual({ $cat_updates: true, [SORTED]: true });

		// From then on it follows the cursor, like any pass: what arrives next
		// is sorted, and what was handled isn't touched again.
		fake.add('next', 10.5, linkedIn);
		const sets: MethodCall[] = [];
		const realRequest = fake.request.bind(fake);
		fake.request = async (calls: MethodCall[]) => {
			sets.push(...calls.filter(([name]) => name === 'Email/set'));
			return realRequest(calls);
		};
		await sortNewMail(ACCT, ME, auth, at(11));
		expect(fake.emails.get('next')!.keywords).toEqual({ $cat_updates: true, [SORTED]: true });
		expect(sets.map(([, args]) => Object.keys(args.update as object))).toEqual([['next']]);
		expect(getJevSettings(ACCT).sortCursor).toBe(at(10).toISOString());
	});

	it('leaves mail you put in a tab yourself where it is, and mail a rule moved out of the Inbox alone', async () => {
		updateJevSettings(ACCT, { jevEnabled: false });
		setPin(ACCT, '@linkedin.com', 'updates');
		setRules(ME, [
			{
				id: 'file',
				name: 'File receipts',
				enabled: true,
				logic: 'allof',
				conditions: [{ id: 'c1', field: 'subject', op: 'contains', value: 'receipt', negate: false }],
				target: { kind: 'folder', mailboxId: 'archive' },
				markRead: false,
				star: false,
				stop: false,
				position: 0,
				createdAt: 0,
				updatedAt: 0
			}
		]);
		setRulesCursor(ME, at(0).toISOString());
		fake.add('mine', JUST_NOW, linkedIn);
		recordCorrections(ACCT, ['mine'], 'important');
		fake.add('pinnedReceipt', JUST_NOW, { ...linkedIn, subject: 'Your receipt' });

		await sortNewMail(ACCT, ME, auth, at(10));

		// Dragged to Important by you: the pin doesn't take it back.
		expect(fake.emails.get('mine')!.keywords).toEqual({ [SORTED]: true });
		expect(getDecision(ACCT, 'mine')).toMatchObject({ correctedTo: 'important', pinnedBy: null });
		// The rule ran first and filed it: out of the Inbox, so no tab and no mark.
		expect(fake.emails.get('pinnedReceipt')!.mailboxIds).toEqual({ archive: true });
		expect(fake.emails.get('pinnedReceipt')!.keywords).toEqual({});
	});

	it('never sends Jev the mail that arrived while it was off, once it is switched on', async () => {
		delete env.JEV_MOCK;
		env.TYPESAFE_API_KEY = 'ts-test-key';
		const fetchMock = vi.fn().mockImplementation(async () => liveAnswer());
		vi.stubGlobal('fetch', fetchMock);
		updateJevSettings(ACCT, { jevEnabled: false });
		setPin(ACCT, '@linkedin.com', 'updates');
		fake.add('before', JUST_NOW, { 'header:list-unsubscribe': ' <x>' });
		await sortNewMail(ACCT, ME, auth, at(10));
		expect(getDecision(ACCT, 'before')?.status).toBe('skipped');

		updateJevSettings(ACCT, { jevEnabled: true }, at(11));
		fake.add('after', 11.5, { 'header:list-unsubscribe': ' <x>' });
		await sortNewMail(ACCT, ME, auth, at(12));

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(String(fetchMock.mock.calls[0][1]?.body)).not.toContain('"before"');
		expect(getDecision(ACCT, 'after')).toMatchObject({ status: 'done', applied: 'newsletters' });
		expect(fake.emails.get('before')!.keywords).toEqual({ [SORTED]: true });
	});

	it('puts pinned mail in its tab while TypeSafe is down, and asks the rest about it once it answers', async () => {
		delete env.JEV_MOCK;
		env.TYPESAFE_API_KEY = 'ts-test-key';
		const fetchMock = noTypeSafe();
		// Spam checks on: even a pinned sender's mail has a question for Jev.
		updateJevSettings(ACCT, { spamMode: 'watch' });
		setPin(ACCT, '@linkedin.com', 'updates');
		fake.add('jobs', JUST_NOW, linkedIn);
		fake.add('person', JUST_NOW, sam);

		await sortNewMail(ACCT, ME, auth, at(10));

		expect(fetchMock).toHaveBeenCalled();
		// The pin needed no answer: in its tab and showing, not held for two minutes.
		expect(fake.emails.get('jobs')!.keywords).toEqual({ $cat_updates: true, [SORTED]: true });
		// Still queued for its spam check, and not charged for TypeSafe's outage.
		expect(getDecision(ACCT, 'jobs')).toMatchObject({ status: 'pending', attempts: 0 });
		// Mail with no pin waits for Jev, as before.
		expect(fake.emails.get('person')!.keywords).toEqual({});

		fetchMock.mockImplementation(
			async () =>
				new Response(
					JSON.stringify({
						model: 'jev-1.13.0',
						answers: { spam: { type: 'noul', noul: 0.02 }, phishing: { type: 'noul', noul: 0.01 } },
						usage: { input_tokens: 10, output_tokens: 2 }
					}),
					{ status: 200 }
				)
		);
		await sortNewMail(ACCT, ME, auth, at(11));
		expect(fake.emails.get('jobs')!.keywords).toEqual({ $cat_updates: true, [SORTED]: true });
		// The record still says the pin put it there.
		expect(getDecision(ACCT, 'jobs')).toMatchObject({
			status: 'done',
			category: 'updates',
			applied: 'updates',
			pinnedBy: '@linkedin.com',
			spam: 0.02
		});
	});

	it('puts pinned mail in its tab when its own call fails though others are answered', async () => {
		delete env.JEV_MOCK;
		env.TYPESAFE_API_KEY = 'ts-test-key';
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		updateJevSettings(ACCT, { spamMode: 'watch' });
		vi.stubGlobal(
			'fetch',
			vi.fn().mockImplementation(async (_url: string, init?: RequestInit) =>
				String(init?.body).includes('New jobs')
					? new Response('{}', { status: 500 })
					: new Response(
							JSON.stringify({
								model: 'jev-1.13.0',
								answers: { spam: { type: 'noul', noul: 0.02 }, phishing: { type: 'noul', noul: 0.01 } },
								usage: { input_tokens: 10, output_tokens: 2 }
							}),
							{ status: 200 }
						)
			)
		);
		setPin(ACCT, '@linkedin.com', 'updates');
		fake.add('jobs', JUST_NOW, linkedIn);
		fake.add('person', JUST_NOW, sam);

		await sortNewMail(ACCT, ME, auth, at(10));

		expect(fake.emails.get('jobs')!.keywords).toEqual({ $cat_updates: true, [SORTED]: true });
		// This one failed on its own, so it is charged an attempt and retried.
		expect(getDecision(ACCT, 'jobs')).toMatchObject({ status: 'pending', attempts: 1 });
		expect(getDecision(ACCT, 'person')?.status).toBe('done');
	});

	it('puts pinned mail in its tab during the pause after a rate limit, asking TypeSafe nothing', async () => {
		delete env.JEV_MOCK;
		env.TYPESAFE_API_KEY = 'ts-test-key';
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const fetchMock = vi.fn().mockImplementation(async () => new Response('{}', { status: 429 }));
		vi.stubGlobal('fetch', fetchMock);
		updateJevSettings(ACCT, { spamMode: 'watch' });
		setPin(ACCT, '@linkedin.com', 'updates');
		fake.add('news', 1, { 'header:list-unsubscribe': ' <x>' });
		vi.useFakeTimers({ toFake: ['setTimeout'] });
		const first = sortNewMail(ACCT, ME, auth, at(10));
		await vi.advanceTimersByTimeAsync(5000);
		await first;
		vi.useRealTimers();

		// Paused. A pinned sender's mail lands, and one from a stranger.
		fetchMock.mockClear();
		fake.add('jobs', 11.5, linkedIn);
		fake.add('person', 11.5, sam);
		await sortNewMail(ACCT, ME, auth, at(12));

		expect(fetchMock).not.toHaveBeenCalled();
		expect(fake.emails.get('jobs')!.keywords).toEqual({ $cat_updates: true, [SORTED]: true });
		expect(getDecision(ACCT, 'jobs')).toMatchObject({ status: 'pending', attempts: 0 });
		expect(fake.emails.get('person')!.keywords).toEqual({});
		expect(getDecision(ACCT, 'person')?.status).toBe('pending');
	});

	it('still lets a spam verdict take pinned mail to Junk, and doesn’t mark it on the way', async () => {
		updateJevSettings(ACCT, { spamMode: 'active' });
		setPin(ACCT, '@linkedin.com', 'updates');
		fake.add('spoof', JUST_NOW, { ...linkedIn, 'header:x-spam-status:asText': 'Yes, score=8.1' });

		await sortNewMail(ACCT, ME, auth, at(10));

		expect(fake.emails.get('spoof')!.mailboxIds).toEqual({ junk: true });
		expect(fake.emails.get('spoof')!.keywords).toEqual({});
	});

	it('checks no spam with Jev off, whatever spam mode is stored for the account', async () => {
		const fetchMock = noTypeSafe();
		// Active spam checks, left on when Jev was switched off.
		updateJevSettings(ACCT, { spamMode: 'active' });
		updateJevSettings(ACCT, { jevEnabled: false });
		setPin(ACCT, '@linkedin.com', 'updates');
		fake.add('spammy', JUST_NOW, { 'header:x-spam-status:asText': 'Yes, score=8.1', subject: 'Cheap watches' });
		fake.add('junked', JUST_NOW, { mailboxIds: { junk: true }, subject: 'Your receipt' });

		await sortNewMail(ACCT, ME, auth, at(10));

		// Nothing is judged, so nothing goes to Junk, and Junk isn't even read.
		expect(fake.emails.get('spammy')!.mailboxIds).toEqual({ inbox: true });
		expect(fake.emails.get('spammy')!.keywords).toEqual({ [SORTED]: true });
		expect(getDecision(ACCT, 'spammy')).toMatchObject({ status: 'skipped', spam: null, spamAction: null });
		expect(getDecision(ACCT, 'junked')).toBeNull();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('carries on when the rules run before it fails, as long as the mail server still knows us', async () => {
		updateJevSettings(ACCT, { jevEnabled: false });
		setPin(ACCT, '@linkedin.com', 'updates');
		setRules(ME, [
			{
				id: 'r',
				name: 'r',
				enabled: true,
				logic: 'allof',
				conditions: [{ id: 'c', field: 'subject', op: 'contains', value: 'x', negate: false }],
				target: { kind: 'none' },
				markRead: true,
				star: false,
				stop: false,
				position: 0,
				createdAt: 0,
				updatedAt: 0
			}
		]);
		setRulesCursor(ME, at(0).toISOString());
		fake.add('jobs', JUST_NOW, linkedIn);
		// The rules scheduler's first request fails; the pass's own go through.
		const realRequest = fake.request.bind(fake);
		let failed = false;
		fake.request = async (calls: MethodCall[]) => {
			if (!failed) {
				failed = true;
				throw new Error('mail server hiccup');
			}
			return realRequest(calls);
		};
		const complaints = vi.spyOn(console, 'error').mockImplementation(() => {});

		await sortNewMail(ACCT, ME, auth, at(10));

		expect(failed).toBe(true);
		expect(complaints).toHaveBeenCalledWith('[jev] rules before sorting failed', ME, expect.any(Error));
		expect(fake.emails.get('jobs')!.keywords).toEqual({ $cat_updates: true, [SORTED]: true });
	});

	it('stops, for the caller to flag the account, when the rules run finds its sign-in refused', async () => {
		const { JMAPAuthError } = await import('$lib/jmap/client');
		setRules(ME, [
			{
				id: 'r',
				name: 'r',
				enabled: true,
				logic: 'allof',
				conditions: [{ id: 'c', field: 'subject', op: 'contains', value: 'x', negate: false }],
				target: { kind: 'none' },
				markRead: true,
				star: false,
				stop: false,
				position: 0,
				createdAt: 0,
				updatedAt: 0
			}
		]);
		setRulesCursor(ME, at(0).toISOString());
		// Only the rules run is refused: were that swallowed, the pass would go on and finish.
		const realRequest = fake.request.bind(fake);
		let refused = false;
		fake.request = async (calls: MethodCall[]) => {
			if (!refused) {
				refused = true;
				throw new JMAPAuthError('Authentication failed');
			}
			return realRequest(calls);
		};
		await expect(sortNewMail(ACCT, ME, auth, at(10))).rejects.toBeInstanceOf(JMAPAuthError);
	});

	it('sorts on when a stored rule can’t be read', async () => {
		updateJevSettings(ACCT, { jevEnabled: false });
		setPin(ACCT, '@linkedin.com', 'updates');
		// A row whose conditions can't be read: it never runs, and holds nothing up.
		getDb()
			.prepare(
				`INSERT INTO rules (account_id, id, position, name, conditions_json, created_at, updated_at) VALUES (?, 'half', 0, '', 'not json', 0, 0)`
			)
			.run(ACCT);
		fake.add('jobs', JUST_NOW, linkedIn);

		await sortNewMail(ACCT, ME, auth, at(10));

		expect(fake.emails.get('jobs')!.keywords).toEqual({ $cat_updates: true, [SORTED]: true });
	});
});

describe('a pins-only pass never reaches back past the Inbox’s hold', () => {
	const SORTED = '$jev_sorted';
	const DAY = 24 * 60;
	const linkedIn = { from: [{ name: 'LinkedIn', email: 'jobs@linkedin.com' }], subject: 'New jobs for you' };
	/** Three days of Inbox mail that nothing sorted, a third of it from the sender pinned later. */
	const threeQuietDays = () => {
		for (let i = 0; i < 300; i++) fake.add(`old${i}`, 20 + i * 14, i % 3 === 0 ? linkedIn : {});
	};
	const oldMailInATab = () => [...fake.emails.values()].filter((e) => e.id.startsWith('old') && Object.keys(e.keywords).length > 0).map((e) => e.id);
	const queued = () =>
		(getDb().prepare(`SELECT COUNT(*) AS n FROM jev_decisions WHERE status = 'pending'`).get() as { n: number }).n;
	/** The message that has just arrived is in its tab and showing, on the first pass, and nothing older was touched. */
	const expectOnlyTheNewMessageSorted = () => {
		expect(fake.emails.get('fresh')!.keywords).toEqual({ $cat_updates: true, [SORTED]: true });
		expect(getDecision(ACCT, 'fresh')).toMatchObject({ status: 'done', pinnedBy: '@linkedin.com' });
		expect(oldMailInATab()).toEqual([]);
		expect(queued()).toBe(0);
	};

	it('after the last pin was removed and another added days later', async () => {
		updateJevSettings(ACCT, { jevEnabled: false });
		setPin(ACCT, '@other.example', 'updates');
		await sortNewMail(ACCT, ME, auth, at(10));
		expect(getJevSettings(ACCT).sortCursor).not.toBeNull();

		// No pins: nothing sorts this Inbox, and the pass forgets where it was.
		getDb().prepare('DELETE FROM jev_sender_pins').run();
		threeQuietDays();
		await sortNewMail(ACCT, ME, auth, at(2 * DAY));
		expect(getJevSettings(ACCT).sortCursor).toBeNull();

		setPin(ACCT, '@linkedin.com', 'updates');
		fake.add('fresh', 3 * DAY + 0.5, linkedIn);
		await sortNewMail(ACCT, ME, auth, at(3 * DAY + 1));

		expectOnlyTheNewMessageSorted();
	});

	it('after the tabs were switched off and on again days later', async () => {
		updateJevSettings(ACCT, { jevEnabled: false });
		setPin(ACCT, '@linkedin.com', 'updates');
		await sortNewMail(ACCT, ME, auth, at(10));

		updateJevSettings(ACCT, { inboxTabs: false });
		threeQuietDays();
		await sortNewMail(ACCT, ME, auth, at(2 * DAY));
		expect(getJevSettings(ACCT).sortCursor).toBeNull();

		updateJevSettings(ACCT, { inboxTabs: true });
		fake.add('fresh', 3 * DAY + 0.5, linkedIn);
		await sortNewMail(ACCT, ME, auth, at(3 * DAY + 1));

		expectOnlyTheNewMessageSorted();
	});

	it('when Jev is enabled for the account but not configured on the server, whatever cursor it left', async () => {
		// jev_enabled = 1 and a cursor from when it was switched on (T0), but no
		// key and no mock: jevMode() is 'off'. The upgrade's own tab-rule
		// conversion can give such an account its first pin.
		delete env.JEV_MOCK;
		threeQuietDays();
		// And something the Jev worker had queued back then, never judged.
		enqueueEmails(ACCT, ['old0'], at(21).getTime());
		setPin(ACCT, '@linkedin.com', 'updates');
		fake.add('fresh', 3 * DAY + 0.5, linkedIn);

		await sortNewMail(ACCT, ME, auth, at(3 * DAY + 1));

		expectOnlyTheNewMessageSorted();
		// What was queued long ago is withdrawn, not sorted three days late.
		expect(getDecision(ACCT, 'old0')?.status).toBe('skipped');
		// Two minutes back at the furthest, then on as any pass.
		expect(Date.parse(getJevSettings(ACCT).sortCursor!)).toBeGreaterThanOrEqual(at(3 * DAY - 1).getTime());

		// When the key comes back, Jev starts from then, as when it is switched
		// on: the days in between are not sent to it.
		env.JEV_MOCK = '1';
		fake.add('later', 3 * DAY + 1.5, { 'header:list-unsubscribe': ' <x>' });
		await sortNewMail(ACCT, ME, auth, at(3 * DAY + 2));
		expect(getDecision(ACCT, 'later')).toMatchObject({ status: 'done', applied: 'newsletters' });
		expect(oldMailInATab()).toEqual([]);
	});

	it('forgets the cursor of an account Jev can’t be asked about and that has no pins, so Jev starts from now when it can', async () => {
		delete env.JEV_MOCK;
		threeQuietDays();
		await sortNewMail(ACCT, ME, auth, at(3 * DAY));
		expect(getJevSettings(ACCT).sortCursor).toBeNull();

		env.JEV_MOCK = '1';
		await sortNewMail(ACCT, ME, auth, at(3 * DAY + 1)); // starts the clock
		fake.add('later', 3 * DAY + 1.5, { 'header:list-unsubscribe': ' <x>' });
		await sortNewMail(ACCT, ME, auth, at(3 * DAY + 2));
		expect(getDecision(ACCT, 'later')?.status).toBe('done');
		expect(oldMailInATab()).toEqual([]);
		expect(getDecision(ACCT, 'old299')).toBeNull();
	});

	it('leaves a queued sort of existing mail queued, for when Jev is back', async () => {
		delete env.JEV_MOCK;
		fake.add('existing', -60, { 'header:list-unsubscribe': ' <x>' });
		enqueueEmails(ACCT, ['existing'], T0.getTime(), true);
		setPin(ACCT, '@linkedin.com', 'updates');
		await sortNewMail(ACCT, ME, auth, at(3 * DAY));
		expect(getDecision(ACCT, 'existing')?.status).toBe('pending');
	});
});
