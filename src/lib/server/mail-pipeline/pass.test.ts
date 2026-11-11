import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Point the lazy SQLite singleton at a throwaway file before anything opens it.
process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'zajel-mail-pipeline-')), 'test.db');

const env = vi.hoisted(() => ({}) as Record<string, string | undefined>);
vi.mock('$env/dynamic/private', () => ({ env }));

// The mail server: one fake per JMAP account (most tests use one).
const jmap = vi.hoisted(() => ({ client: null as unknown, clients: {} as Record<string, unknown>, sessions: 0, sessionFails: false }));
// A session with an address book, so "is the sender a contact" gets a real
// answer (the fake holds no cards) rather than "couldn't tell".
vi.mock('$lib/jmap/auth', () => ({
	createClient: (a: { accountId: string }) => jmap.clients[a.accountId] ?? jmap.client,
	fetchSession: () => {
		jmap.sessions++;
		if (jmap.sessionFails) return Promise.reject(new Error('session unavailable'));
		return Promise.resolve({
			capabilities: { 'urn:ietf:params:jmap:contacts': {} },
			primaryAccounts: { 'urn:ietf:params:jmap:contacts': 'jmap-acc' },
			accounts: { 'jmap-acc': { accountCapabilities: { 'urn:ietf:params:jmap:contacts': {} } } }
		});
	}
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
vi.mock('$lib/server/jev/urgent', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/jev/urgent')>()),
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
import { markAccountTaskDone } from '$lib/server/db/queries/account-tasks';
import { patchPrefs } from '$lib/server/db/queries/app-prefs';
import { importRules } from '$lib/server/rules/store';
import { INBOX_HOLD_MS, isHeld } from '$lib/inbox-hold';
import { recordSenderMoves, setPin } from '$lib/server/db/queries/jev-learning';
import type { AuthState, MethodCall } from '$lib/jmap/types';
import type { Rule } from '$lib/types/rules';
import { forgetRateLimits } from '$lib/server/jev/health';
import { runPass } from './pass';
import { requestPass, runScheduledPasses } from './index';
import { getCursor, MAX_ARRIVAL_ATTEMPTS, pruneArrivals, setCursor } from './arrivals';

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

/** A rule matching a word in the subject, filing into `target` (by default the News label). */
function labelRule(id: string, word: string, target: Rule['target'] = { kind: 'label', mailboxId: 'news' }, over: Partial<Rule> = {}): Rule {
	return {
		id,
		name: id,
		enabled: true,
		logic: 'allof',
		conditions: [{ id: `${id}-c`, field: 'subject', op: 'contains', value: word, negate: false }],
		target,
		markRead: false,
		star: false,
		stop: false,
		position: 0,
		createdAt: 0,
		updatedAt: 0,
		...over
	};
}

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
	/** Messages created (out-of-office replies) and submissions sent. */
	created: Record<string, unknown>[] = [];
	submitted: Record<string, unknown>[] = [];

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
							{ id: 'projects', name: 'Projects', role: null, sortOrder: 7, parentId: null },
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
				case 'Identity/get':
					result = { list: [{ id: 'ident-1', email: ME, name: 'Me' }] };
					break;
				case 'EmailSubmission/set':
					this.submitted.push(...Object.values(args.create as Record<string, Record<string, unknown>>));
					result = { created: Object.fromEntries(Object.keys(args.create as object).map((k) => [k, { id: `sub-${k}` }])) };
					break;
				case 'Email/set': {
					if (args.create) {
						this.created.push(...Object.values(args.create as Record<string, Record<string, unknown>>));
						result = { created: Object.fromEntries(Object.keys(args.create as object).map((k) => [k, { id: `new-${this.created.length}` }])) };
						break;
					}
					if (args.destroy) {
						result = { destroyed: args.destroy };
						break;
					}
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
	// Its one-time tasks are done, so a pass asks the mail server only for mail.
	markAccountTaskDone(ACCT, 'retire_sieve_script');
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
	getDb().prepare('DELETE FROM mail_arrivals').run();
	getDb().prepare('DELETE FROM auto_reply_log').run();
	patchPrefs('user-1', { auto_reply_enabled: 'off' });
	forgetRateLimits();
	log.events = [];
	telegram.wanted = false;
	jmap.clients = {};
	jmap.sessions = 0;
	jmap.sessionFails = false;
	// Off and on again, so every test's Jev starts at T0; and the pipeline
	// has read up to T0, as it would have, running every minute.
	updateJevSettings(ACCT, { jevEnabled: false });
	updateJevSettings(ACCT, { inboxTabs: true, jevEnabled: true, spamMode: 'off' }, T0);
	setCursor(ACCT, T0.toISOString(), T0);
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

describe('a pass over new mail, with Jev', () => {
	it('starts Jev’s clock when it finds Jev on with none, sending it nothing from before', async () => {
		// As after the upgrade for an account Jev had no place for.
		getDb().prepare('UPDATE jev_settings SET jev_since = NULL').run();
		fake.add('old', 1, { 'header:list-unsubscribe': ' <x>' });

		await runPass(ACCT, auth, { now: at(5) });

		expect(getJevSettings(ACCT).jevSince).toBe(at(5).toISOString());
		expect(fake.emails.get('old')!.keywords).toEqual({});
		expect(getDecision(ACCT, 'old')).toBeNull();
		// Nor on the next pass: it arrived before Jev was on.
		await runPass(ACCT, auth, { now: at(6) });
		expect(getDecision(ACCT, 'old')).toBeNull();
	});

	it('withdraws what was queued before it found Jev on again, so none of it is sent', async () => {
		// Left queued from before: Jev couldn't be asked for a while, and its clock was stopped.
		getDb().prepare('UPDATE jev_settings SET jev_since = NULL').run();
		fake.add('stale', 1, { 'header:list-unsubscribe': ' <x>' });
		enqueueEmails(ACCT, ['stale'], at(1).getTime());

		await runPass(ACCT, auth, { now: at(5) });
		await runPass(ACCT, auth, { now: at(6) });

		expect(getDecision(ACCT, 'stale')?.status).toBe('skipped');
		expect(fake.emails.get('stale')!.keywords).toEqual({});
	});

	it('never sends Jev mail that landed just before it was switched on', async () => {
		updateJevSettings(ACCT, { jevEnabled: false });
		// The minute's run, with nothing on.
		await runPass(ACCT, auth, { now: at(3) });
		fake.add('before', 4, { 'header:list-unsubscribe': ' <x>' });
		updateJevSettings(ACCT, { jevEnabled: true }, at(4.5));
		fake.add('after', 5, { 'header:list-unsubscribe': ' <x>' });

		await runPass(ACCT, auth, { now: at(10) });

		expect(getDecision(ACCT, 'before')).toBeNull();
		expect(fake.emails.get('before')!.keywords).toEqual({});
		expect(getDecision(ACCT, 'after')).toMatchObject({ status: 'done', applied: 'newsletters' });
	});

	it('sorts what arrived since sorting was switched on, and nothing else', async () => {
		fake.add('old', -10, { 'header:list-unsubscribe': ' <x>' });
		fake.add('news', 1, { 'header:list-unsubscribe': ' <x>', subject: 'Issue 212' });
		fake.add('promo', 2, { 'header:list-unsubscribe': ' <x>', subject: '48 hours: 30% off' });
		fake.add('person', 3, { from: [{ name: 'Sam', email: 'sam@example.com' }] });
		// You moved this to Updates before Jev got to it: it stays there.
		fake.add('moved', 4, { 'header:list-unsubscribe': ' <x>', keywords: { $cat_updates: true } });

		await runPass(ACCT, auth, { now: at(10) });

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
		expect(getCursor(ACCT)).toBe(at(9).toISOString());
		// Jev's own clock doesn't move: it is when Jev was switched on.
		expect(getJevSettings(ACCT).jevSince).toBe(T0.toISOString());
		// Mock answers cost nothing and aren't counted.
		expect(getUsage(ACCT).requests).toBe(0);
	});

	it('moves on past a full page of mail stamped with the same second', async () => {
		// A bulk import: 100 messages, one receivedAt.
		for (let i = 0; i < 100; i += 1) fake.add(`bulk-${i}`, 5);
		await runPass(ACCT, auth, { now: at(10) });
		await runPass(ACCT, auth, { now: at(11) });
		// Stepping back a second for ties would land on the same cursor forever.
		expect(getCursor(ACCT)).toBe(at(5).toISOString());
		await runPass(ACCT, auth, { now: at(12) });
		expect(getCursor(ACCT)).toBe(at(11).toISOString());
	});

	it('does nothing while the tabs are off', async () => {
		updateJevSettings(ACCT, { inboxTabs: false });
		fake.add('news', 1, { 'header:list-unsubscribe': ' <x>' });
		await runPass(ACCT, auth, { now: at(10) });
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

		await runPass(ACCT, auth, { now: at(10) });
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

		await runPass(ACCT, auth, { now: at(10) });
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
		await runPass(ACCT, auth, { now: at(11) });
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
		await runPass(ACCT, auth, { now: at(10) });
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

		await runPass(ACCT, auth, { now: at(10) });

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

		await runPass(ACCT, auth, { now: at(10) });
		// Nothing was written, nothing claims it was, and the server's words
		// are kept: a bare "refused" can't tell a bad patch from a gone message.
		expect(fake.emails.get('news')!.keywords).toEqual({});
		expect(getDecision(ACCT, 'news')).toMatchObject({ status: 'pending', attempts: 1, applied: null });
		expect(getDecision(ACCT, 'news')?.lastError).toBe(
			'The mail server refused the change: invalidPatch: Invalid patch value (keywords)'
		);

		// The next pass asks again and, accepted this time, puts it in its tab.
		refuse = false;
		await runPass(ACCT, auth, { now: at(11) });
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
			await runPass(ACCT, auth, { now: at(10 + pass) });
		}
		expect(fake.emails.get('old2')!.keywords).toEqual({ $cat_newsletters: true });
		expect(logged('write_')).toEqual(['write_refused']);
		expect(log.events.find((e) => e.event === 'write_refused')?.fields).toMatchObject({
			count: 1,
			error: 'forbidden: Mailbox is read-only'
		});

		refuse = false;
		await runPass(ACCT, auth, { now: at(13) });
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

		await runPass(ACCT, auth, { now: at(10) });
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

		await runPass(ACCT, auth, { now: at(10) });
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

		await runPass(ACCT, auth, { now: at(10) });
		for (const id of ['a', 'b']) {
			expect(getDecision(ACCT, id)).toMatchObject({ status: 'pending', attempts: 1, lastError: 'TypeSafe returned an error (400)' });
		}
		// Given up on after its attempts, so the queue moves on.
		for (let pass = 1; pass < 5; pass++) await runPass(ACCT, auth, { now: at(10 + pass) });
		expect(getDecision(ACCT, 'a')).toMatchObject({ status: 'failed', attempts: 5 });
	});

	it('leaves mail you put in Important yourself where it is', async () => {
		fake.add('news', 1, { 'header:list-unsubscribe': ' <x>' });
		enqueueEmails(ACCT, ['news'], at(1).getTime());
		// Dragged to Updates and back to Important before Jev got to it.
		recordCorrections(ACCT, ['news'], 'important');

		await runPass(ACCT, auth, { now: at(10) });

		expect(fake.emails.get('news')!.keywords).toEqual({});
		expect(getDecision(ACCT, 'news')).toMatchObject({ status: 'done', applied: null, correctedTo: 'important', model: null });
	});

	it('gives up on a message TypeSafe refuses, even when it is the only one asked', async () => {
		delete env.JEV_MOCK;
		env.TYPESAFE_API_KEY = 'ts-test-key';
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"error":"state too large"}', { status: 400 })));
		fake.add('huge', 1, { 'header:list-unsubscribe': ' <x>' });

		await runPass(ACCT, auth, { now: at(10) });
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
		const first = runPass(ACCT, auth, { now: at(10) });
		await vi.advanceTimersByTimeAsync(5000);
		await first;
		vi.useRealTimers();
		expect(fetchMock).toHaveBeenCalledTimes(3); // the call and its two retries
		expect(getDecision(ACCT, 'news')).toMatchObject({ status: 'pending', attempts: 0 });

		// The next passes leave TypeSafe alone, while still queuing what arrives...
		fetchMock.mockClear();
		fake.add('later', 11, { 'header:list-unsubscribe': ' <x>' });
		await runPass(ACCT, auth, { now: at(12) });
		expect(fetchMock).not.toHaveBeenCalled();
		expect(getDecision(ACCT, 'later')?.status).toBe('pending');

		// ...and once the pause is over, it asks again.
		fetchMock.mockImplementation(async () => liveAnswer());
		await runPass(ACCT, auth, { now: at(16) });
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

		await runPass(ACCT, auth, { now: at(10) });

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

		await runPass(ACCT, auth, { now: at(10) });

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
		// Older than the cursor: only a backfill reaches these.
		fake.add('oldNews', -60, { 'header:list-unsubscribe': ' <x>', subject: 'Your invoice digest' });
		fake.add('oldPinned', -50, { from: [{ name: 'Shop', email: 'deals@shop.example' }] });
		fake.add('oldSorted', -40, { keywords: { $cat_updates: true } });
		setPin(ACCT, '@shop.example', 'promotions');
		enqueueEmails(ACCT, ['oldNews', 'oldPinned', 'oldSorted'], T0.getTime(), true);

		await runPass(ACCT, auth, { now: at(10) });

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

		await runPass(ACCT, auth, { now: at(10) });

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
			await runPass(ACCT, auth, { now: at(10) });
			expect(telegram.notify).not.toHaveBeenCalled();

			telegram.wanted = true;
			fake.add('pager', 11, { subject: 'Database unreachable' });
			await runPass(ACCT, auth, { now: at(20) });
			expect(telegram.notify).toHaveBeenCalledTimes(1);
			expect(telegram.notify).toHaveBeenCalledWith(ACCT, expect.objectContaining({ id: 'pager' }));
		});

		it('asks Jev even when nothing else needs asking', async () => {
			updateJevSettings(ACCT, { inboxTabs: false });
			telegram.wanted = true;
			fake.add('only', 1, { subject: 'Your flight was cancelled' });
			await runPass(ACCT, auth, { now: at(10) });
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
			await runPass(ACCT, auth, { now: at(MONTH + 10) });

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

			await runPass(ACCT, auth, { now: at(10) });
			expect(fake.emails.get('news')!.keywords).toEqual({});
			expect(getDecision(ACCT, 'news')?.status).not.toBe('done');

			// Nor does it go out once Jev is back on.
			updateJevSettings(ACCT, { jevEnabled: true }, at(MONTH));
			await runPass(ACCT, auth, { now: at(MONTH + 10) });
			expect(fake.emails.get('news')!.keywords).toEqual({});
			expect(getDecision(ACCT, 'news')?.status).toBe('skipped');
			expect(getCursor(ACCT)).toBe(at(MONTH + 9).toISOString());
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

			await runPass(ACCT, auth, { now: at(10) });

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

			await runPass(ACCT, auth, { now: at(10) });

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

			await runPass(ACCT, auth, { now: at(10) });

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

			await runPass(ACCT, auth, { now: at(10) });

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

			await runPass(ACCT, auth, { now: at(10) });

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

			await runPass(ACCT, auth, { now: at(10) });

			expect(fake.emails.get('spammy')!.mailboxIds).toEqual({ junk: true, news: true, newlbl: true });
			// The fresh list knows the new folder: the move leaves it, as any move leaves every folder.
			expect(fake.emails.get('wronglyJunked')!.mailboxIds).toEqual({ inbox: true, newlbl: true });
			expect(fake.mailboxGets).toBe(2);
		});

		it('fetches the folders only once in a pass whose mail is all in folders it knows', async () => {
			updateJevSettings(ACCT, { spamMode: 'active' });
			fake.add('spammy', 1, { ...flagged, mailboxIds: { inbox: true, news: true } });

			await runPass(ACCT, auth, { now: at(10) });

			expect(fake.emails.get('spammy')!.mailboxIds).toEqual({ junk: true, news: true });
			expect(fake.mailboxGets).toBe(1);
		});

		it('leaves Junk alone while spam checks are off', async () => {
			fake.add('wronglyJunked', 1, { mailboxIds: { junk: true } });
			await runPass(ACCT, auth, { now: at(10) });
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

		await runPass(ACCT, auth, { now: at(10) });

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

		await runPass(ACCT, auth, { now: at(10) });

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

		await runPass(ACCT, auth, { now: at(10) });

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

		await runPass(ACCT, auth, { now: at(10) });

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

		await runPass(ACCT, auth, { now: at(10) });

		expect(fake.emails.get('spammy')!.mailboxIds).toEqual({ junk: true });
		expect(fake.emails.get('spammy')!.keywords).toEqual({});
		expect(fake.emails.get('wronglyJunked')!.mailboxIds).toEqual({ inbox: true });
		expect(fake.emails.get('wronglyJunked')!.keywords).toEqual({ [SORTED]: true });
	});

	it('writes no mark while the Inbox has no tabs, as nothing is held then', async () => {
		updateJevSettings(ACCT, { inboxTabs: false, spamMode: 'watch' });
		fake.add('person', JUST_NOW, { from: [{ name: 'Sam', email: 'sam@example.com' }] });

		await runPass(ACCT, auth, { now: at(10) });

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
				second = requestPass(ACCT, auth);
			}
			return realRequest(calls);
		};
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(at(10));

		await requestPass(ACCT, auth);
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

		await runPass(ACCT, auth, { now: at(10) });

		expect(fake.emails.get('gh')!.mailboxIds).toEqual({ inbox: true, archive: true });
		expect(fake.emails.get('gh')!.keywords).toEqual({ $cat_newsletters: true, [SORTED]: true });
		expect(inOrder).toEqual([
			{ mailboxIds: { inbox: true, archive: true } },
			{ 'keywords/$cat_newsletters': true, [`keywords/${SORTED}`]: true }
		]);
		fake.request = watched;
		// The next pass reads that minute again, and finds nothing left to do.
		const writes: MethodCall[] = [];
		const realRequest = fake.request.bind(fake);
		fake.request = async (calls: MethodCall[]) => {
			writes.push(...calls.filter(([name]) => name === 'Email/set'));
			return realRequest(calls);
		};
		await runPass(ACCT, auth, { now: at(10.2) });
		expect(writes).toEqual([]);
	});

	it('writes the rule’s change before Jev is called, so rules never wait on it', async () => {
		delete env.JEV_MOCK;
		env.TYPESAFE_API_KEY = 'ts-test-key';
		setRules(ME, [labelGithub]);
		fake.add('gh', JUST_NOW, { from: [{ name: 'GitHub', email: 'noreply@github.com' }], 'header:list-unsubscribe': ' <x>' });
		const order: string[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				order.push('jev');
				return liveAnswer();
			})
		);
		const realRequest = fake.request.bind(fake);
		fake.request = async (calls: MethodCall[]) => {
			for (const [name, args] of calls) if (name === 'Email/set') order.push(Object.keys((args.update as Record<string, unknown>).gh as object).join(','));
			return realRequest(calls);
		};

		await runPass(ACCT, auth, { now: at(10) });

		expect(order).toEqual(['mailboxIds', 'jev', `keywords/$cat_newsletters,keywords/${SORTED}`]);
	});

	it('keeps exact rules working while TypeSafe is down', async () => {
		delete env.JEV_MOCK;
		env.TYPESAFE_API_KEY = 'ts-test-key';
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 500 })));
		setRules(ME, [labelGithub]);
		fake.add('gh', JUST_NOW, { from: [{ name: 'GitHub', email: 'noreply@github.com' }] });

		await runPass(ACCT, auth, { now: at(10) });

		// The rule's label is on; no mark, so the hold's timeout lets it through.
		expect(fake.emails.get('gh')!.mailboxIds).toEqual({ inbox: true, archive: true });
		expect(fake.emails.get('gh')!.keywords).toEqual({});
	});

	it('runs rules first with the tabs off too, so a rule’s move lands before a spam verdict could take the message', async () => {
		updateJevSettings(ACCT, { inboxTabs: false, spamMode: 'active' });
		const githubToArchive: Rule = { ...labelGithub, id: 'gh-move', target: { kind: 'folder', mailboxId: 'archive' } };
		setRules(ME, [githubToArchive]);
		// Stalwart flagged it, and nobody here knows the sender: Jev would junk it.
		fake.add('ghMoved', JUST_NOW, { from: [{ name: 'GitHub', email: 'noreply@github.com' }], 'header:x-spam-status:asText': 'Yes, score=8.1' });
		fake.add('spammy', JUST_NOW, { 'header:x-spam-status:asText': 'Yes, score=8.1' });

		await runPass(ACCT, auth, { now: at(10) });

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
		fake.add('ghFlagged', JUST_NOW, { from: [{ name: 'GitHub', email: 'noreply@github.com' }] });

		await runPass(ACCT, auth, { now: at(10) });
		await runPass(ACCT, auth, { now: at(10.5) });

		expect(fake.emails.get('ghFlagged')!.mailboxIds).toEqual({ inbox: true });
	});

	it('leaves mail judged while the tabs were off unmarked: it waits out the hold, no longer', async () => {
		updateJevSettings(ACCT, { inboxTabs: false, spamMode: 'watch' });
		fake.add('p', JUST_NOW, { from: [{ name: 'Sam', email: 'sam@example.com' }] });
		await runPass(ACCT, auth, { now: at(10) });
		updateJevSettings(ACCT, { inboxTabs: true });
		await runPass(ACCT, auth, { now: at(10.1) });

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

		await requestPass(ACCT, auth, { fromStream: true });
		expect(getDecision(ACCT, 'news')?.status).toBe('done');
		expect(getDecision(ACCT, 'old')?.status).toBe('pending');

		await requestPass(ACCT, auth);
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

		await requestPass(ACCT, auth);
		expect(fetchMock).toHaveBeenCalled();

		// Mail lands, and its change asks for a pass: TypeSafe is left alone.
		fetchMock.mockClear();
		fake.add('b', JUST_NOW + 0.2, { 'header:list-unsubscribe': ' <x>' });
		await requestPass(ACCT, auth, { fromStream: true });
		expect(fetchMock).not.toHaveBeenCalled();

		// The scheduled pass tries again, and once TypeSafe answers, the
		// stream's passes do too.
		fetchMock.mockImplementation(async () => liveAnswer());
		await requestPass(ACCT, auth);
		expect(getDecision(ACCT, 'b')?.status).toBe('done');
		fake.add('c', JUST_NOW + 0.3, { 'header:list-unsubscribe': ' <x>' });
		await requestPass(ACCT, auth, { fromStream: true });
		expect(getDecision(ACCT, 'c')?.status).toBe('done');
	});

	it('doesn’t chain a pass onto every write of the backlog when driven by the stream', async () => {
		const { startStreams, stopStreams } = await import('./stream');
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

		startStreams(requestPass);
		await new Promise((resolve) => setTimeout(resolve, 3500));
		stopStreams();

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

		await runPass(ACCT, auth, { now: at(10) });

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

		await runPass(ACCT, auth, { now: at(10) });

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
		await runPass(ACCT, auth, { now: at(10) });
		// Pins, but no tabs to put mail in.
		setPin(ACCT, '@linkedin.com', 'updates');
		updateJevSettings(ACCT, { inboxTabs: false });
		await runPass(ACCT, auth, { now: at(10) });

		expect(requests).toEqual([]);
		expect(jmap.sessions).toBe(0);
		expect(fake.emails.get('jobs')!.keywords).toEqual({});
		expect(getJevSettings(ACCT).jevSince).toBeNull();
		// The cursor keeps up with the time, so switching something on later never reaches back.
		expect(getCursor(ACCT)).toBe(at(10).toISOString());
	});

	it('pins act on mail that arrives once they are added, and leave older mail alone', async () => {
		updateJevSettings(ACCT, { jevEnabled: false });
		fake.add('old', 5, linkedIn); // before the pin: nothing acted on new mail then
		// The minute's run, with nothing on.
		await runPass(ACCT, auth, { now: at(5.5) });
		setPin(ACCT, '@linkedin.com', 'updates');
		fake.add('held', JUST_NOW, linkedIn);

		await runPass(ACCT, auth, { now: at(10) });

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
		await runPass(ACCT, auth, { now: at(11) });
		expect(fake.emails.get('next')!.keywords).toEqual({ $cat_updates: true, [SORTED]: true });
		expect(sets.map(([, args]) => Object.keys(args.update as object))).toEqual([['next']]);
		expect(getCursor(ACCT)).toBe(at(10).toISOString());
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
		fake.add('mine', JUST_NOW, linkedIn);
		recordCorrections(ACCT, ['mine'], 'important');
		fake.add('pinnedReceipt', JUST_NOW, { ...linkedIn, subject: 'Your receipt' });

		await runPass(ACCT, auth, { now: at(10) });

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
		await runPass(ACCT, auth, { now: at(10) });
		expect(getDecision(ACCT, 'before')?.status).toBe('skipped');

		updateJevSettings(ACCT, { jevEnabled: true }, at(11));
		fake.add('after', 11.5, { 'header:list-unsubscribe': ' <x>' });
		await runPass(ACCT, auth, { now: at(12) });

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

		await runPass(ACCT, auth, { now: at(10) });

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
		await runPass(ACCT, auth, { now: at(11) });
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

		await runPass(ACCT, auth, { now: at(10) });

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
		const first = runPass(ACCT, auth, { now: at(10) });
		await vi.advanceTimersByTimeAsync(5000);
		await first;
		vi.useRealTimers();

		// Paused. A pinned sender's mail lands, and one from a stranger.
		fetchMock.mockClear();
		fake.add('jobs', 11.5, linkedIn);
		fake.add('person', 11.5, sam);
		await runPass(ACCT, auth, { now: at(12) });

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

		await runPass(ACCT, auth, { now: at(10) });

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

		await runPass(ACCT, auth, { now: at(10) });

		// Nothing is judged, so nothing goes to Junk, and Junk isn't even read.
		expect(fake.emails.get('spammy')!.mailboxIds).toEqual({ inbox: true });
		expect(fake.emails.get('spammy')!.keywords).toEqual({ [SORTED]: true });
		expect(getDecision(ACCT, 'spammy')).toMatchObject({ status: 'skipped', spam: null, spamAction: null });
		expect(getDecision(ACCT, 'junked')).toBeNull();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('picks up a pass that failed part-way on the next one: rules and pins act then', async () => {
		updateJevSettings(ACCT, { jevEnabled: false });
		setPin(ACCT, '@linkedin.com', 'updates');
		setRules(ME, [
			{
				id: 'r',
				name: 'r',
				enabled: true,
				logic: 'allof',
				conditions: [{ id: 'c', field: 'subject', op: 'contains', value: 'jobs', negate: false }],
				target: { kind: 'none' },
				markRead: true,
				star: false,
				stop: false,
				position: 0,
				createdAt: 0,
				updatedAt: 0
			}
		]);
		fake.add('jobs', JUST_NOW, linkedIn);
		// The mail server fails the pass's read of the new mail, once.
		const realRequest = fake.request.bind(fake);
		let failed = false;
		fake.request = async (calls: MethodCall[]) => {
			if (!failed && calls[0][0] === 'Email/get' && Array.isArray(calls[0][1].ids)) {
				failed = true;
				throw new Error('mail server hiccup');
			}
			return realRequest(calls);
		};

		await expect(runPass(ACCT, auth, { now: at(10) })).rejects.toThrow('mail server hiccup');
		expect(fake.emails.get('jobs')!.keywords).toEqual({});

		await runPass(ACCT, auth, { now: at(10.1) });
		expect(fake.emails.get('jobs')!.keywords).toEqual({ $seen: true, $cat_updates: true, [SORTED]: true });
	});

	it('stops, and marks the account for signing in again, when the mail server refuses its password', async () => {
		const { JMAPAuthError } = await import('$lib/jmap/client');
		const accounts = await import('$lib/server/auth/accounts');
		const reauth = vi.spyOn(accounts, 'markNeedsReauth').mockImplementation(() => {});
		fake.add('news', JUST_NOW, { 'header:list-unsubscribe': ' <x>' });
		// Refused after the new mail was read: were that swallowed, the pass would go on and finish.
		const realRequest = fake.request.bind(fake);
		let calls = 0;
		fake.request = async (c: MethodCall[]) => {
			if (++calls === 3) throw new JMAPAuthError('Authentication failed');
			return realRequest(c);
		};
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(at(10));

		await requestPass(ACCT, auth);

		expect(reauth).toHaveBeenCalledWith(ACCT);
		expect(fake.emails.get('news')!.keywords).toEqual({});
		expect(getDecision(ACCT, 'news')?.status).not.toBe('done');
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

		await runPass(ACCT, auth, { now: at(10) });

		expect(fake.emails.get('jobs')!.keywords).toEqual({ $cat_updates: true, [SORTED]: true });
	});
});

describe('switching pins, tabs or Jev on never acts on mail from before', () => {
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
	/** The minute's run during the quiet days, with nothing on: it asks the mail server nothing. */
	const quietDays = async () => {
		const requests: MethodCall[][] = [];
		const realRequest = fake.request.bind(fake);
		fake.request = async (calls: MethodCall[]) => {
			requests.push(calls);
			return realRequest(calls);
		};
		for (let day = 1; day <= 3; day++) await runPass(ACCT, auth, { now: at(day * DAY) });
		fake.request = realRequest;
		expect(requests).toEqual([]);
	};

	it('after the last pin was removed and another added days later', async () => {
		updateJevSettings(ACCT, { jevEnabled: false });
		setPin(ACCT, '@other.example', 'updates');
		await runPass(ACCT, auth, { now: at(10) });

		// No pins: nothing acts on this Inbox's new mail.
		getDb().prepare('DELETE FROM jev_sender_pins').run();
		threeQuietDays();
		await quietDays();

		setPin(ACCT, '@linkedin.com', 'updates');
		fake.add('fresh', 3 * DAY + 0.5, linkedIn);
		await runPass(ACCT, auth, { now: at(3 * DAY + 1) });

		expectOnlyTheNewMessageSorted();
	});

	it('after the tabs were switched off and on again days later', async () => {
		updateJevSettings(ACCT, { jevEnabled: false });
		setPin(ACCT, '@linkedin.com', 'updates');
		await runPass(ACCT, auth, { now: at(10) });

		updateJevSettings(ACCT, { inboxTabs: false });
		threeQuietDays();
		await quietDays();

		updateJevSettings(ACCT, { inboxTabs: true });
		fake.add('fresh', 3 * DAY + 0.5, linkedIn);
		await runPass(ACCT, auth, { now: at(3 * DAY + 1) });

		expectOnlyTheNewMessageSorted();
	});

	it('when Jev is enabled for the account but not configured on the server', async () => {
		// jev_enabled = 1 and switched on at T0, but no key and no mock:
		// jevMode() is 'off'. The upgrade's own tab-rule conversion can give
		// such an account its first pin.
		delete env.JEV_MOCK;
		threeQuietDays();
		// And something Jev had queued back then, never judged.
		enqueueEmails(ACCT, ['old0'], at(21).getTime());
		await quietDays();
		// What was queued for Jev is withdrawn, not sorted days late, and Jev's clock is stopped.
		expect(getDecision(ACCT, 'old0')?.status).toBe('skipped');
		expect(getJevSettings(ACCT).jevSince).toBeNull();

		setPin(ACCT, '@linkedin.com', 'updates');
		fake.add('fresh', 3 * DAY + 0.5, linkedIn);
		await runPass(ACCT, auth, { now: at(3 * DAY + 1) });
		expectOnlyTheNewMessageSorted();

		// When the key comes back, Jev starts from then, as when it is switched
		// on: what arrived before, even a moment before, is not sent to it.
		env.JEV_MOCK = '1';
		fake.add('before', 3 * DAY + 1.5, { 'header:list-unsubscribe': ' <x>' });
		await runPass(ACCT, auth, { now: at(3 * DAY + 2) });
		expect(getJevSettings(ACCT).jevSince).toBe(at(3 * DAY + 2).toISOString());
		fake.add('later', 3 * DAY + 2.5, { 'header:list-unsubscribe': ' <x>' });
		await runPass(ACCT, auth, { now: at(3 * DAY + 3) });
		expect(getDecision(ACCT, 'before')).toBeNull();
		expect(getDecision(ACCT, 'later')).toMatchObject({ status: 'done', applied: 'newsletters' });
		expect(oldMailInATab()).toEqual([]);
	});

	it('forgets when Jev was on for an account Jev can’t be asked about, so Jev starts from now when it can', async () => {
		delete env.JEV_MOCK;
		threeQuietDays();
		await quietDays();
		expect(getJevSettings(ACCT).jevSince).toBeNull();

		env.JEV_MOCK = '1';
		await runPass(ACCT, auth, { now: at(3 * DAY + 1) }); // starts the clock
		fake.add('later', 3 * DAY + 1.5, { 'header:list-unsubscribe': ' <x>' });
		await runPass(ACCT, auth, { now: at(3 * DAY + 2) });
		expect(getDecision(ACCT, 'later')?.status).toBe('done');
		expect(oldMailInATab()).toEqual([]);
		expect(getDecision(ACCT, 'old299')).toBeNull();
	});

	it('when Jev itself is switched on, after days with rules only', async () => {
		updateJevSettings(ACCT, { jevEnabled: false });
		setRules(ME, [labelRule('r', 'nothing-matches')]);
		threeQuietDays();
		for (let day = 1; day <= 3; day++) await runPass(ACCT, auth, { now: at(day * DAY) });
		updateJevSettings(ACCT, { jevEnabled: true }, at(3 * DAY));
		fake.add('fresh', 3 * DAY + 0.5, { 'header:list-unsubscribe': ' <x>' });
		await runPass(ACCT, auth, { now: at(3 * DAY + 1) });
		expect(getDecision(ACCT, 'fresh')).toMatchObject({ status: 'done', applied: 'newsletters' });
		expect(oldMailInATab()).toEqual([]);
		expect(queued()).toBe(0);
	});

	it('leaves a queued sort of existing mail queued, for when Jev is back', async () => {
		delete env.JEV_MOCK;
		fake.add('existing', -60, { 'header:list-unsubscribe': ' <x>' });
		enqueueEmails(ACCT, ['existing'], T0.getTime(), true);
		setPin(ACCT, '@linkedin.com', 'updates');
		await runPass(ACCT, auth, { now: at(3 * DAY) });
		expect(getDecision(ACCT, 'existing')?.status).toBe('pending');
	});
});

describe('one pass, one cursor', () => {
	const JUST_NOW = 9.5;
	const SORTED = '$jev_sorted';
	const linkedIn = { from: [{ name: 'LinkedIn', email: 'jobs@linkedin.com' }], subject: 'New jobs for you' };
	/** Every request the pass makes to the mail server. */
	const watchRequests = () => {
		const requests: MethodCall[][] = [];
		const realRequest = fake.request.bind(fake);
		fake.request = async (calls: MethodCall[]) => {
			requests.push(calls);
			return realRequest(calls);
		};
		return requests;
	};

	it('rules only: files new mail, and the cursor moves on', async () => {
		updateJevSettings(ACCT, { jevEnabled: false, inboxTabs: false });
		setRules(ME, [labelRule('r', 'invoice')]);
		fake.add('bill', JUST_NOW, { subject: 'Your invoice' });

		await runPass(ACCT, auth, { now: at(10) });

		expect(fake.emails.get('bill')!.mailboxIds).toEqual({ inbox: true, news: true });
		expect(getCursor(ACCT)).toBe(at(9).toISOString());
		// Jev saw nothing.
		expect(getDecision(ACCT, 'bill')).toBeNull();
	});

	it('Jev only: sorts new mail, and the cursor moves on', async () => {
		fake.add('news', JUST_NOW, { 'header:list-unsubscribe': ' <x>' });

		await runPass(ACCT, auth, { now: at(10) });

		expect(fake.emails.get('news')!.keywords).toEqual({ $cat_newsletters: true, [SORTED]: true });
		expect(getCursor(ACCT)).toBe(at(9).toISOString());
	});

	it('rules and Jev: one read of the Inbox serves both', async () => {
		setRules(ME, [labelRule('r', 'issue')]);
		fake.add('news', JUST_NOW, { 'header:list-unsubscribe': ' <x>', subject: 'Issue 212' });
		const requests = watchRequests();

		await runPass(ACCT, auth, { now: at(10) });

		expect(fake.emails.get('news')!.mailboxIds).toEqual({ inbox: true, news: true });
		expect(fake.emails.get('news')!.keywords).toEqual({ $cat_newsletters: true, [SORTED]: true });
		const inboxReads = requests
			.flat()
			.filter(([name, args]) => name === 'Email/query' && JSON.stringify(args.filter).includes('"inMailbox":"inbox"'));
		expect(inboxReads).toHaveLength(1);
		expect(getCursor(ACCT)).toBe(at(9).toISOString());
	});

	it('neither: the cursor keeps up with the time and the mail server is asked nothing', async () => {
		updateJevSettings(ACCT, { jevEnabled: false, inboxTabs: false });
		fake.add('mail', JUST_NOW);
		const requests = watchRequests();

		await runPass(ACCT, auth, { now: at(10) });

		expect(requests).toEqual([]);
		expect(jmap.sessions).toBe(0);
		expect(getCursor(ACCT)).toBe(at(10).toISOString());
		// Switching a rule on afterwards doesn't reach back to it.
		setRules(ME, [labelRule('r', 'hello')]);
		await runPass(ACCT, auth, { now: at(11) });
		expect(fake.emails.get('mail')!.mailboxIds).toEqual({ inbox: true });
	});

	it('pins with Jev off: a pinned sender’s new mail goes to its tab, and the cursor moves on', async () => {
		updateJevSettings(ACCT, { jevEnabled: false });
		setPin(ACCT, '@linkedin.com', 'updates');
		fake.add('jobs', JUST_NOW, linkedIn);

		await runPass(ACCT, auth, { now: at(10) });

		expect(fake.emails.get('jobs')!.keywords).toEqual({ $cat_updates: true, [SORTED]: true });
		expect(getCursor(ACCT)).toBe(at(9).toISOString());
	});

	it('starts from now on first sight of an account, so nothing already there is acted on', async () => {
		getDb().prepare('DELETE FROM mail_pipeline').run();
		setRules(ME, [labelRule('r', 'hello')]);
		fake.add('before', 9);

		await runPass(ACCT, auth, { now: at(10) });
		expect(getCursor(ACCT)).toBe(at(10).toISOString());
		await runPass(ACCT, auth, { now: at(11) });

		expect(fake.emails.get('before')!.mailboxIds).toEqual({ inbox: true });
		expect(getDecision(ACCT, 'before')).toBeNull();
	});

	it('steps back a second behind a full page, so the rest of the last second is read next time', async () => {
		updateJevSettings(ACCT, { jevEnabled: false, inboxTabs: false });
		setRules(ME, [labelRule('r', 'hello')]);
		for (let i = 0; i < 99; i++) fake.add(`m${i}`, 5);
		fake.add('m99', 5 + 5 / 60);

		await runPass(ACCT, auth, { now: at(10) });

		expect(getCursor(ACCT)).toBe(new Date(at(5).getTime() + 4000).toISOString());
	});
});

describe('new mail is handled once', () => {
	const JUST_NOW = 9.5;
	const away = () => patchPrefs('user-1', { auto_reply_enabled: 'on', auto_reply_body: 'Away', auto_reply_since: T0.toISOString() });
	const unhandled = () =>
		getDb().prepare('SELECT email_id AS id, attempts FROM mail_arrivals WHERE handled_at IS NULL ORDER BY email_id').all() as { id: string; attempts: number }[];
	/** Email/set updates the pass makes, by message. */
	const watchWrites = () => {
		const writes: string[] = [];
		const realRequest = fake.request.bind(fake);
		fake.request = async (calls: MethodCall[]) => {
			for (const [name, args] of calls) if (name === 'Email/set' && args.update) writes.push(...Object.keys(args.update as object));
			return realRequest(calls);
		};
		return writes;
	};

	it('is answered, filed and alerted once, across passes and the look-back', async () => {
		away();
		telegram.wanted = true;
		telegram.notify.mockClear();
		setRules(ME, [labelRule('r', 'lunch', { kind: 'label', mailboxId: 'news' }, { markRead: true })]);
		fake.add('m1', JUST_NOW, { subject: 'Lunch?', from: [{ name: 'Bob', email: 'bob@outside.test' }] });
		const writes = watchWrites();

		await runPass(ACCT, auth, { now: at(10) });
		// You take the rule's label off and keep the message as it is.
		fake.emails.get('m1')!.mailboxIds = { inbox: true };
		fake.emails.get('m1')!.keywords = {};
		// The next pass reads the same minute again; so does one after a restart.
		await runPass(ACCT, auth, { now: at(10.2) });
		await runPass(ACCT, auth, { now: at(10.4) });
		// It isn't filed again, nor marked read again.
		expect(fake.emails.get('m1')!.mailboxIds).toEqual({ inbox: true });
		expect(fake.emails.get('m1')!.keywords).toEqual({});

		expect(fake.created).toHaveLength(1);
		expect(fake.submitted).toHaveLength(1);
		expect(writes.filter((id) => id === 'm1')).toHaveLength(2); // the rule's write, then Jev's tab and marker
		expect(telegram.notify).toHaveBeenCalledTimes(1);
		expect(getDb().prepare(`SELECT rules_json FROM mail_arrivals WHERE email_id = 'm1'`).get()).toEqual({ rules_json: '["r"]' });
	});

	it('is tried again on the next pass when a pass fails part-way, without answering twice', async () => {
		away();
		updateJevSettings(ACCT, { jevEnabled: false, inboxTabs: false });
		setRules(ME, [labelRule('r', 'lunch')]);
		fake.add('m1', JUST_NOW, { subject: 'Lunch?', from: [{ name: 'Bob', email: 'bob@outside.test' }] });
		// The pass dies after the reply went out, when it reads where the message is before writing.
		const realRequest = fake.request.bind(fake);
		let failed = false;
		fake.request = async (calls: MethodCall[]) => {
			const props = calls[0][1].properties as string[] | undefined;
			if (!failed && calls[0][0] === 'Email/get' && props?.length === 3) {
				failed = true;
				throw new Error('connection reset');
			}
			return realRequest(calls);
		};

		await expect(runPass(ACCT, auth, { now: at(10) })).rejects.toThrow('connection reset');
		expect(unhandled()).toEqual([{ id: 'm1', attempts: 1 }]);
		expect(fake.created).toHaveLength(1);

		await runPass(ACCT, auth, { now: at(10.2) });
		expect(unhandled()).toEqual([]);
		expect(fake.emails.get('m1')!.mailboxIds).toEqual({ inbox: true, news: true });
		// Out-of-office's once-a-day check: no second reply.
		expect(fake.created).toHaveLength(1);
	});

	it(`is given up on after ${MAX_ARRIVAL_ATTEMPTS} failed passes, with a log line`, async () => {
		updateJevSettings(ACCT, { jevEnabled: false, inboxTabs: false });
		setRules(ME, [labelRule('r', 'lunch')]);
		fake.add('m1', JUST_NOW, { subject: 'Lunch?' });
		const realRequest = fake.request.bind(fake);
		let broken = true;
		fake.request = async (calls: MethodCall[]) => {
			if (broken && calls[0][0] === 'Email/get' && Array.isArray(calls[0][1].ids)) throw new Error('cannot read it');
			return realRequest(calls);
		};

		for (let pass = 0; pass < MAX_ARRIVAL_ATTEMPTS; pass++) {
			await expect(runPass(ACCT, auth, { now: at(10 + pass * 0.1) })).rejects.toThrow('cannot read it');
		}
		expect(unhandled()).toEqual([{ id: 'm1', attempts: MAX_ARRIVAL_ATTEMPTS }]);
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		await runPass(ACCT, auth, { now: at(10.6) });
		expect(unhandled()).toEqual([]);
		expect(logged('arrivals_given_up')).toEqual(['arrivals_given_up']);

		broken = false;
		await runPass(ACCT, auth, { now: at(10.7) });
		expect(fake.emails.get('m1')!.mailboxIds).toEqual({ inbox: true });
	});

	it('is marked handled and queued for Jev together, or neither', async () => {
		const { markHandled, recordArrivals } = await import('./arrivals');
		recordArrivals(ACCT, [{ emailId: 'm1', mailbox: 'inbox', receivedAt: at(1).toISOString() }], at(2));
		// The queue refuses the write: the arrival must stay unhandled, to be tried again.
		getDb().exec(`CREATE TEMP TRIGGER refuse_queue BEFORE INSERT ON jev_decisions BEGIN SELECT RAISE(ABORT, 'queue refused'); END`);
		try {
			expect(() => markHandled(ACCT, [{ emailId: 'm1' }], ['m1'], at(2))).toThrow('queue refused');
		} finally {
			getDb().exec('DROP TRIGGER refuse_queue');
		}
		expect(unhandled()).toEqual([{ id: 'm1', attempts: 0 }]);
		expect(getDecision(ACCT, 'm1')).toBeNull();

		markHandled(ACCT, [{ emailId: 'm1' }], ['m1'], at(2));
		expect(unhandled()).toEqual([]);
		expect(getDecision(ACCT, 'm1')?.status).toBe('pending');
	});

	it('is forgotten after a week', async () => {
		const { recordArrivals } = await import('./arrivals');
		const DAY = 24 * 60;
		recordArrivals(ACCT, [{ emailId: 'old', mailbox: 'inbox', receivedAt: at(0).toISOString() }], at(0));
		recordArrivals(ACCT, [{ emailId: 'recent', mailbox: 'inbox', receivedAt: at(2 * DAY).toISOString() }], at(2 * DAY));
		expect(pruneArrivals(at(7 * DAY + 60))).toBe(1);
		expect(getDb().prepare('SELECT email_id FROM mail_arrivals').all()).toEqual([{ email_id: 'recent' }]);
	});
});

describe('rules on new mail', () => {
	const JUST_NOW = 9.5;

	beforeEach(() => {
		updateJevSettings(ACCT, { jevEnabled: false, inboxTabs: false });
	});

	it('are passed over, even switched on: one waiting to be rewritten, and one with a condition Jev judged', async () => {
		const flagged = labelRule('flagged', 'lunch', undefined, { attention: 'jev_condition' });
		// As it was stored before the upgrade, the Jev condition still there.
		const unconverted = labelRule('old', 'lunch');
		unconverted.conditions = [...unconverted.conditions, { id: 'j', field: 'jev' as never, op: 'contains', value: 'an invoice', negate: false }];
		setRules(ME, [flagged, unconverted]);
		fake.add('m1', JUST_NOW, { subject: 'Lunch?' });

		await runPass(ACCT, auth, { now: at(10) });
		expect(fake.emails.get('m1')!.mailboxIds).toEqual({ inbox: true });

		// The next message, once the rule is an ordinary one again.
		setRules(ME, [labelRule('r', 'lunch')]);
		fake.add('m2', 10.2, { subject: 'Lunch again?' });
		await runPass(ACCT, auth, { now: at(10.5) });
		expect(fake.emails.get('m2')!.mailboxIds).toEqual({ inbox: true, news: true });
	});

	it('leave alone a message you moved between the pass reading it and writing', async () => {
		setRules(ME, [labelRule('r', 'lunch')]);
		fake.add('m1', JUST_NOW, { subject: 'Lunch?' });
		const realRequest = fake.request.bind(fake);
		fake.request = async (calls: MethodCall[]) => {
			const result = await realRequest(calls);
			// Archived by you just after the pass read the new mail.
			if (calls[0][0] === 'Email/get' && Array.isArray(calls[0][1].ids) && (calls[0][1].properties as string[]).includes('subject')) {
				fake.emails.get('m1')!.mailboxIds = { archive: true };
			}
			return result;
		};

		await runPass(ACCT, auth, { now: at(10) });

		expect(fake.emails.get('m1')!.mailboxIds).toEqual({ archive: true });
	});

	it('still label a message whose tab you changed meanwhile, and leave your tab', async () => {
		updateJevSettings(ACCT, { inboxTabs: true, jevEnabled: true });
		setRules(ME, [labelRule('r', 'lunch')]);
		fake.add('m1', JUST_NOW, { subject: 'Lunch?', 'header:list-unsubscribe': ' <x>' });
		const realRequest = fake.request.bind(fake);
		fake.request = async (calls: MethodCall[]) => {
			const result = await realRequest(calls);
			if (calls[0][0] === 'Email/get' && Array.isArray(calls[0][1].ids) && (calls[0][1].properties as string[]).includes('subject')) {
				fake.emails.get('m1')!.keywords = { $cat_promotions: true };
			}
			return result;
		};

		await runPass(ACCT, auth, { now: at(10) });

		expect(fake.emails.get('m1')!.mailboxIds).toEqual({ inbox: true, news: true });
		expect(fake.emails.get('m1')!.keywords).toEqual({ $cat_promotions: true, $jev_sorted: true });
	});

	it('move a message out of every folder and keep a label made during the pass, fetching the folders once more', async () => {
		setRules(ME, [labelRule('r', 'lunch', { kind: 'folder', mailboxId: 'projects' })]);
		fake.madeLater = [
			{ id: 'newlbl', name: 'Fresh', role: null, sortOrder: 0, parentId: 'labels' },
			{ id: 'newdir', name: 'Fresh folder', role: null, sortOrder: 0, parentId: null }
		];
		fake.add('m0', JUST_NOW, { subject: 'Lunch?', mailboxIds: { inbox: true, news: true, newlbl: true } });
		fake.add('m1', JUST_NOW, { subject: 'Lunch?', mailboxIds: { inbox: true, newdir: true } });

		await runPass(ACCT, auth, { now: at(10) });

		expect(fake.emails.get('m0')!.mailboxIds).toEqual({ projects: true, news: true, newlbl: true });
		// The fresh list knows the new folder: the move leaves it.
		expect(fake.emails.get('m1')!.mailboxIds).toEqual({ projects: true });
		expect(fake.mailboxGets).toBe(2);
	});

	it('fetch the folders once when every message is in folders they know', async () => {
		setRules(ME, [labelRule('r', 'lunch', { kind: 'folder', mailboxId: 'projects' })]);
		fake.add('m0', JUST_NOW, { subject: 'Lunch?', mailboxIds: { inbox: true, news: true } });

		await runPass(ACCT, auth, { now: at(10) });

		expect(fake.emails.get('m0')!.mailboxIds).toEqual({ projects: true, news: true });
		expect(fake.mailboxGets).toBe(1);
	});
});

describe('the account’s one-time tasks', () => {
	it('run on every pass, with something on or nothing, and never hold the rules up', async () => {
		updateJevSettings(ACCT, { jevEnabled: false, inboxTabs: false });
		getDb().prepare('DELETE FROM account_tasks').run();
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			// The task fails (the mail server's session can't be read); the rules act all the same.
			jmap.sessionFails = true;
			setRules(ME, [labelRule('r', 'lunch')]);
			fake.add('m1', 9.5, { subject: 'Lunch?' });
			await runPass(ACCT, auth, { now: at(10) });
			expect(jmap.sessions).toBe(1);
			expect(fake.emails.get('m1')!.mailboxIds).toEqual({ inbox: true, news: true });

			// An hour later, with nothing on, it is tried again, and done.
			jmap.sessionFails = false;
			setRules(ME, []);
			vi.useFakeTimers({ toFake: ['Date'] });
			vi.setSystemTime(Date.now() + 61 * 60_000);
			await runPass(ACCT, auth, { now: at(11) });
			expect(jmap.sessions).toBe(2);
			expect(getDb().prepare('SELECT name FROM account_tasks').all()).toEqual([{ name: 'retire_sieve_script' }]);
		} finally {
			markAccountTaskDone(ACCT, 'retire_sieve_script');
		}
	});
});

describe('out-of-office', () => {
	const JUST_NOW = 9.5;
	const bob = { from: [{ name: 'Bob', email: 'bob@outside.test' }], subject: 'Lunch?' };

	beforeEach(() => {
		updateJevSettings(ACCT, { jevEnabled: false, inboxTabs: false });
		patchPrefs('user-1', { auto_reply_enabled: 'on', auto_reply_body: 'Away', auto_reply_since: T0.toISOString() });
	});

	it('answers new mail with no rules, reading what the reply decision needs, and moves nothing', async () => {
		fake.add('m1', JUST_NOW, bob);
		const gets: string[][] = [];
		const realRequest = fake.request.bind(fake);
		fake.request = async (calls: MethodCall[]) => {
			for (const [name, args] of calls) if (name === 'Email/get' && Array.isArray(args.ids)) gets.push(args.properties as string[]);
			return realRequest(calls);
		};

		await runPass(ACCT, auth, { now: at(10) });

		expect(fake.created).toHaveLength(1);
		expect(fake.created[0]).toMatchObject({ to: [{ name: 'Bob', email: 'bob@outside.test' }], 'header:Auto-Submitted:asText': 'auto-replied' });
		expect(gets[0]).toEqual(expect.arrayContaining(['replyTo', 'header:auto-submitted:asText', 'subject']));
		expect(fake.emails.get('m1')!.mailboxIds).toEqual({ inbox: true });
		expect(fake.emails.get('m1')!.keywords).toEqual({});
	});

	it('answers on a pass the event stream asked for', async () => {
		fake.add('m1', JUST_NOW, bob);
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(at(10));

		await requestPass(ACCT, auth, { fromStream: true });

		expect(fake.created).toHaveLength(1);
	});

	it('is given only mail no pass before has seen', async () => {
		fake.add('m1', JUST_NOW, bob);
		await runPass(ACCT, auth, { now: at(10) });
		// The next pass reads that minute again, with one more message in it.
		fake.add('m2', 9.8, { ...bob, from: [{ name: 'Ann', email: 'ann@outside.test' }] });
		await runPass(ACCT, auth, { now: at(10.2) });
		expect(fake.created.map((c) => (c.to as { email: string }[])[0].email)).toEqual(['bob@outside.test', 'ann@outside.test']);
	});

	it('answers nothing on first sight of an account', async () => {
		getDb().prepare('DELETE FROM mail_pipeline').run();
		fake.add('m1', JUST_NOW, bob);
		await runPass(ACCT, auth, { now: at(10) });
		await runPass(ACCT, auth, { now: at(10.2) });
		expect(fake.created).toEqual([]);
	});

	it('never stops the rules when it fails', async () => {
		setRules(ME, [labelRule('r', 'lunch')]);
		fake.add('m1', JUST_NOW, bob);
		const realRequest = fake.request.bind(fake);
		fake.request = async (calls: MethodCall[]) => {
			if (calls[0][0] === 'Identity/get') throw new Error('identities unavailable');
			return realRequest(calls);
		};
		const complaints = vi.spyOn(console, 'error').mockImplementation(() => {});

		await runPass(ACCT, auth, { now: at(10) });

		expect(complaints).toHaveBeenCalledWith('[mail] out-of-office failed', ACCT, expect.any(Error));
		expect(fake.emails.get('m1')!.mailboxIds).toEqual({ inbox: true, news: true });
	});
});

describe('a pass the event stream asked for, while TypeSafe is down', () => {
	it('still runs rules and pins, and makes no call to TypeSafe', async () => {
		delete env.JEV_MOCK;
		env.TYPESAFE_API_KEY = 'ts-test-key';
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 500 }));
		vi.stubGlobal('fetch', fetchMock);
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(at(10));
		fake.add('a', 9.5, { 'header:list-unsubscribe': ' <x>' });
		// A scheduled pass finds TypeSafe down.
		await requestPass(ACCT, auth);
		expect(fetchMock).toHaveBeenCalled();

		fetchMock.mockClear();
		setRules(ME, [labelRule('r', 'jobs')]);
		setPin(ACCT, '@linkedin.com', 'updates');
		fake.add('b', 9.7, { from: [{ name: 'LinkedIn', email: 'jobs@linkedin.com' }], subject: 'New jobs for you' });
		await requestPass(ACCT, auth, { fromStream: true });

		expect(fetchMock).not.toHaveBeenCalled();
		expect(fake.emails.get('b')!.mailboxIds).toEqual({ inbox: true, news: true });
		expect(fake.emails.get('b')!.keywords).toEqual({ $cat_updates: true, $jev_sorted: true });
		expect(getDecision(ACCT, 'b')).toMatchObject({ status: 'pending', attempts: 0 });
	});
});

describe('the minute’s run', () => {
	it('runs accounts side by side: a slow Jev call for one doesn’t hold up the other’s rules', async () => {
		const SECOND = 'acct-2';
		const db = getDb();
		db.prepare(
			`INSERT OR IGNORE INTO mail_accounts (id, user_id, email, server_url, jmap_account_id, secret_enc)
			 VALUES (?, 'user-1', 'two@example.test', 'https://mail.example', 'jmap-2', 'x')`
		).run(SECOND);
		markAccountTaskDone(SECOND, 'retire_sieve_script');
		setCursor(SECOND, T0.toISOString(), T0);
		importRules(SECOND, [labelRule('r', 'lunch')]);
		const other = new FakeJmap();
		jmap.clients['jmap-2'] = other;
		const auth2 = { ...auth, accountId: 'jmap-2' } as AuthState;
		const accounts = await import('$lib/server/auth/accounts');
		vi.spyOn(accounts, 'listSchedulableAuths').mockReturnValue([
			{ account: { id: ACCT, email: ME } as never, auth, email: ME },
			{ account: { id: SECOND, email: 'two@example.test' } as never, auth: auth2, email: 'two@example.test' }
		]);
		// The first account's Jev call doesn't answer until told to.
		delete env.JEV_MOCK;
		env.TYPESAFE_API_KEY = 'ts-test-key';
		let answer!: () => void;
		const asked = new Promise<void>((resolve) => {
			vi.stubGlobal(
				'fetch',
				vi.fn(() => {
					resolve();
					return new Promise<Response>((r) => (answer = () => r(liveAnswer())));
				})
			);
		});
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(at(10));
		fake.add('news', 9.5, { 'header:list-unsubscribe': ' <x>' });
		other.add('lunch', 9.5, { subject: 'Lunch?' });

		const tick = runScheduledPasses();
		await asked;
		await vi.waitFor(() => expect(other.emails.get('lunch')!.mailboxIds).toEqual({ inbox: true, news: true }));
		expect(fake.emails.get('news')!.keywords).toEqual({});

		answer();
		await tick;
		expect(fake.emails.get('news')!.keywords).toEqual({ $cat_newsletters: true, $jev_sorted: true });
		db.prepare('DELETE FROM mail_accounts WHERE id = ?').run(SECOND);
	});
});
