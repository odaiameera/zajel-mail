import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MethodCall } from '$lib/jmap/types';

interface FakeEmail {
	id: string;
	mailboxIds: Record<string, boolean>;
	keywords: Record<string, boolean>;
	from: { name: string | null; email: string }[];
	subject: string;
	receivedAt: string;
}

/** Evaluates the filter conditions the watcher sends, as the mail server would. */
function matches(filter: Record<string, unknown>, e: FakeEmail): boolean {
	const conditions = filter.conditions as Record<string, unknown>[] | undefined;
	if (filter.operator === 'AND') return conditions!.every((c) => matches(c, e));
	if (filter.operator === 'OR') return conditions!.some((c) => matches(c, e));
	if (filter.operator === 'NOT') return !conditions!.some((c) => matches(c, e));
	const at = Date.parse(e.receivedAt);
	if ('inMailbox' in filter) return !!e.mailboxIds[filter.inMailbox as string];
	if ('hasKeyword' in filter) return !!e.keywords[filter.hasKeyword as string];
	if ('notKeyword' in filter) return !e.keywords[filter.notKeyword as string];
	if ('after' in filter) return at > Date.parse(filter.after as string);
	if ('before' in filter) return at < Date.parse(filter.before as string);
	throw new Error(`unexpected condition ${JSON.stringify(filter)}`);
}

const mail = vi.hoisted(() => ({
	emails: new Map<string, unknown>(),
	hold: true,
	sent: [] as { title: string; tag?: string }[]
}));

vi.mock('$lib/jmap/auth', () => ({
	createClient: () => ({
		async request(calls: MethodCall[]) {
			const done: [string, Record<string, unknown>, string][] = [];
			for (const [name, args, tag] of calls) {
				if (name === 'Email/query') {
					const sort = (args.sort as { isAscending: boolean }[])[0];
					const ids = [...(mail.emails.values() as Iterable<FakeEmail>)]
						.filter((e) => matches(args.filter as Record<string, unknown>, e))
						.sort((a, b) => (sort.isAscending ? 1 : -1) * a.receivedAt.localeCompare(b.receivedAt))
						.slice(0, args.limit as number)
						.map((e) => e.id);
					done.push([name, { ids }, tag]);
				} else {
					const ref = args['#ids'] as { resultOf: string } | undefined;
					const ids = ref ? (done.find((d) => d[2] === ref.resultOf)![1].ids as string[]) : (args.ids as string[]);
					const found = ids.filter((id) => mail.emails.has(id));
					done.push([name, { list: found.map((id) => structuredClone(mail.emails.get(id))) }, tag]);
				}
			}
			return { methodResponses: done, sessionState: '' };
		}
	})
}));
vi.mock('$lib/jmap/mailbox', () => ({
	getMailboxes: async () => [
		{ id: 'inbox', role: 'inbox' },
		{ id: 'junk', role: 'junk' }
	]
}));
vi.mock('../auth/accounts', () => ({
	authStateForAccount: () => ({ accountId: 'jmap-acc', apiUrl: 'https://mail.example/jmap/', authHeader: 'Basic x' }),
	listAccounts: () => [],
	markNeedsReauth: vi.fn()
}));
vi.mock('../db/queries/app-prefs', () => ({ getPrefs: () => ({ notifications: 'on' }) }));
vi.mock('../db/queries/push', () => ({ usersWithPushSubscriptions: () => [] }));
vi.mock('../calendar/service', () => ({ upcomingReminders: async () => [] }));
vi.mock('../jev/hold', () => ({ inboxHoldOn: () => mail.hold }));
vi.mock('./send', () => ({
	sendPushToUser: async (_user: string, _account: string, payload: { title: string; tag?: string }) => {
		mail.sent.push(payload);
	}
}));

import { MailWatcher } from './worker';
import { INBOX_HOLD_MS, JEV_SORTED_KEYWORD } from '$lib/inbox-hold';

const NOW = Date.parse('2026-11-10T10:00:00Z');
const iso = (secondsFromNow: number) => new Date(NOW + secondsFromNow * 1000).toISOString().replace('.000Z', 'Z');

function add(id: string, secondsFromNow: number, extra: Partial<FakeEmail> = {}) {
	mail.emails.set(id, {
		id,
		mailboxIds: { inbox: true },
		keywords: {},
		from: [{ name: id, email: `${id}@example.com` }],
		subject: `About ${id}`,
		receivedAt: iso(secondsFromNow),
		...extra
	});
}
const email = (id: string) => mail.emails.get(id) as FakeEmail;
const sortedByJev = (id: string) => (email(id).keywords[JEV_SORTED_KEYWORD] = true);
const announced = () => mail.sent.map((p) => p.title);

type Internals = { baseline(auth: unknown): Promise<void>; checkOnce(): Promise<void> };
let watcher: MailWatcher;
const inner = () => watcher as unknown as Internals;

async function startWatching() {
	watcher = new MailWatcher({
		account: { id: 'acct-1', email: 'me@example.test' } as never,
		userId: 'user-1',
		multiAccount: false
	});
	await inner().baseline({});
}

beforeEach(() => {
	mail.emails.clear();
	mail.hold = true;
	mail.sent = [];
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(NOW);
	add('old', -3600, { keywords: {} });
});

afterEach(() => {
	watcher?.stop();
	vi.useRealTimers();
});

describe('push for new mail while Jev sorts the Inbox', () => {
	it('waits for Jev before announcing a new Inbox message, then announces it once', async () => {
		await startWatching();
		add('news', 1);
		vi.setSystemTime(NOW + 2000);

		await inner().checkOnce();
		expect(announced()).toEqual([]);

		sortedByJev('news');
		await inner().checkOnce();
		await inner().checkOnce();
		expect(announced()).toEqual(['news']);
	});

	it('announces it anyway once the hold runs out, if Jev never answers', async () => {
		await startWatching();
		add('news', 1);
		vi.setSystemTime(NOW + 2000);
		await inner().checkOnce();
		expect(announced()).toEqual([]);

		vi.setSystemTime(NOW + 1000 + INBOX_HOLD_MS + 1000);
		await inner().checkOnce();
		expect(announced()).toEqual(['news']);
	});

	it('never announces mail Jev sends to Junk', async () => {
		await startWatching();
		add('spam', 1);
		vi.setSystemTime(NOW + 2000);
		await inner().checkOnce();

		email('spam').mailboxIds = { junk: true };
		sortedByJev('spam');
		await inner().checkOnce();
		vi.setSystemTime(NOW + INBOX_HOLD_MS * 2);
		await inner().checkOnce();
		expect(announced()).toEqual([]);
	});

	it('still announces a held message after a later one went out first', async () => {
		await startWatching();
		add('slow', 1);
		add('quick', 3);
		vi.setSystemTime(NOW + 4000);
		sortedByJev('quick');
		await inner().checkOnce();
		expect(announced()).toEqual(['quick']);

		sortedByJev('slow');
		await inner().checkOnce();
		expect(announced()).toEqual(['quick', 'slow']);
	});

	it('announces at once, as before, while nothing is held', async () => {
		mail.hold = false;
		await startWatching();
		add('news', 1);
		vi.setSystemTime(NOW + 2000);
		await inner().checkOnce();
		expect(announced()).toEqual(['news']);
	});

	it('picks up mail held when it started, without announcing what was already showing', async () => {
		add('held', -20);
		add('shown', -10, { keywords: { [JEV_SORTED_KEYWORD]: true } });
		await startWatching();
		await inner().checkOnce();
		expect(announced()).toEqual([]);

		sortedByJev('held');
		await inner().checkOnce();
		expect(announced()).toEqual(['held']);
	});

	it('announces a message dated in the future at once, and never sets a timer past one hold', async () => {
		await startWatching();
		// An import, an APPEND or a wrong clock: dated 30 days ahead.
		add('future', 30 * 86_400);
		vi.setSystemTime(NOW + 2000);
		const timers = vi.spyOn(globalThis, 'setTimeout');

		await inner().checkOnce();

		expect(announced()).toEqual(['future']);
		const delays = timers.mock.calls.map((call) => call[1] ?? 0);
		expect(Math.max(0, ...delays)).toBeLessThanOrEqual(INBOX_HOLD_MS + 1000);
	});

	it('still announces a held message when twenty newer ones arrive during its hold', async () => {
		await startWatching();
		add('held', 1);
		for (let i = 0; i < 20; i++) add(`n${i}`, 2 + i, { keywords: { [JEV_SORTED_KEYWORD]: true } });
		vi.setSystemTime(NOW + 30_000);
		await inner().checkOnce();
		expect(announced()).not.toContain('held');

		vi.setSystemTime(NOW + INBOX_HOLD_MS + 5000);
		await inner().checkOnce();
		expect(announced().filter((t) => t === 'held')).toHaveLength(1);
	});

	it('looks again by itself when the hold runs out, with no event from the server', async () => {
		vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
		vi.setSystemTime(NOW);
		await startWatching();
		add('news', 1);
		vi.setSystemTime(NOW + 2000);
		await inner().checkOnce();
		expect(announced()).toEqual([]);

		// The release timer, then the check's own short debounce.
		await vi.advanceTimersByTimeAsync(INBOX_HOLD_MS + 5000);
		expect(announced()).toEqual(['news']);
	});
});
