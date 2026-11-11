import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'zajel-auto-reply-')), 'test.db');

import { getDb } from './db/index';
import { runMigrations } from './db/migrate';
import { patchPrefs } from './db/queries/app-prefs';
import {
	answerNewMail,
	autoReplyActiveAt,
	autoReplyStatus,
	nextSince,
	outOfOfficeFor,
	parseAutoReplyForm,
	pruneOldAutoReplies,
	shouldAutoReply,
	type AutoReplySettings,
	type OutOfOffice,
	type ReplyContext
} from './auto-reply';
import type { JMAPClient } from '$lib/jmap/client';
import type { Email, Mailbox } from '$lib/jmap/types';

const NOW = new Date('2026-11-20T12:00:00Z');

const settings = (over: Partial<AutoReplySettings> = {}): AutoReplySettings => ({
	enabled: true,
	subject: '',
	body: 'I am away until Monday.',
	from: '',
	until: '',
	tz: 'UTC',
	since: '2026-11-20T08:00:00.000Z',
	...over
});

const email = (over: Partial<Email> = {}): Email => ({
	id: 'e1',
	blobId: 'b1',
	threadId: 't1',
	mailboxIds: { IN: true },
	from: [{ name: 'Bob', email: 'Bob@Outside.test' }],
	to: [{ name: null, email: 'me@example.test' }],
	cc: null,
	subject: 'Lunch?',
	receivedAt: '2026-11-20T11:00:00Z',
	size: 100,
	preview: '',
	keywords: {},
	hasAttachment: false,
	messageId: ['m1@outside.test'],
	references: null,
	replyTo: null,
	...over
});

const ctx = (over: Partial<ReplyContext> = {}): ReplyContext => ({
	settings: settings(),
	now: NOW,
	accountEmail: 'me@example.test',
	accountAddresses: new Set(['me@example.test', 'alias@example.test']),
	ownAddresses: new Set(['me@example.test', 'alias@example.test', 'other@mine.test']),
	answered: new Set(),
	sentLastHour: 0,
	...over
});

const decide = (e: Partial<Email> = {}, c: Partial<ReplyContext> = {}) => shouldAutoReply(email(e), ctx(c));
const replies = (e: Partial<Email> = {}, c: Partial<ReplyContext> = {}) => 'to' in decide(e, c);

describe('shouldAutoReply', () => {
	it('answers an ordinary message to the sender', () => {
		expect(decide()).toEqual({ to: { name: 'Bob', email: 'Bob@Outside.test' }, sender: 'bob@outside.test' });
	});

	it('answers the Reply-To address when there is one', () => {
		expect(decide({ replyTo: [{ name: 'Desk', email: 'desk@outside.test' }] })).toMatchObject({
			to: { email: 'desk@outside.test' }
		});
	});

	describe('1. only while on, for mail since it was switched on, from the last day', () => {
		it('not while switched off, or with no message', () => {
			expect(replies({}, { settings: settings({ enabled: false }) })).toBe(false);
			expect(replies({}, { settings: settings({ body: '  ' }) })).toBe(false);
		});
		it('not once the end date has passed, even for mail that came in on the last day', () => {
			const c = { settings: settings({ since: '2026-11-19T00:00:00Z', until: '2026-11-19' }) };
			expect(replies({ receivedAt: '2026-11-19T23:00:00Z' }, c)).toBe(false);
			expect(replies({ receivedAt: '2026-11-19T23:00:00Z' }, { ...c, now: new Date('2026-11-19T23:30:00Z') })).toBe(true);
		});
		it('not for settings saved before it was sent by the app (no switch-on time)', () => {
			expect(replies({}, { settings: settings({ since: '' }) })).toBe(false);
		});
		it('not for mail that arrived before it was switched on', () => {
			expect(replies({ receivedAt: '2026-11-20T07:59:59Z' })).toBe(false);
		});
		it('not for mail more than a day old', () => {
			const old = { settings: settings({ since: '2026-11-01T00:00:00Z' }) };
			expect(replies({ receivedAt: '2026-11-19T11:59:00Z' }, old)).toBe(false);
			expect(replies({ receivedAt: '2026-11-19T12:01:00Z' }, old)).toBe(true);
		});
		it('not for mail that arrived on a day before the start date', () => {
			const c = { settings: settings({ since: '2026-11-19T00:00:00Z', from: '2026-11-20' }) };
			expect(replies({ receivedAt: '2026-11-19T23:59:00Z' }, c)).toBe(false);
			expect(replies({ receivedAt: '2026-11-20T00:01:00Z' }, c)).toBe(true);
		});
	});

	describe('2. never to automatic or bulk mail', () => {
		it('Auto-Submitted, unless it says "no"', () => {
			expect(replies({ 'header:auto-submitted:asText': 'auto-generated' })).toBe(false);
			expect(replies({ 'header:auto-submitted:asText': 'auto-replied' })).toBe(false);
			expect(replies({ 'header:auto-submitted:asText': 'no' })).toBe(true);
		});
		it('Precedence bulk, list or junk', () => {
			for (const p of ['bulk', 'list', 'junk']) expect(replies({ 'header:precedence:asText': p })).toBe(false);
			expect(replies({ 'header:precedence:asText': 'first-class' })).toBe(true);
		});
		it('List-Id', () => {
			expect(replies({ 'header:list-id:asText': '<news.shop.test>' })).toBe(false);
		});
		it('List-Unsubscribe', () => {
			expect(replies({ 'header:list-unsubscribe': '<mailto:leave@shop.test>' })).toBe(false);
		});
		it('X-Auto-Response-Suppress asking for none', () => {
			for (const v of ['All', 'OOF', 'DR, AutoReply', 'oof']) expect(replies({ 'header:x-auto-response-suppress:asText': v })).toBe(false);
			expect(replies({ 'header:x-auto-response-suppress:asText': 'DR, RN' })).toBe(true);
		});
	});

	describe('3. never to a missing or robot address', () => {
		it('no sender address', () => {
			expect(replies({ from: null })).toBe(false);
			expect(replies({ from: [{ name: 'Nobody', email: '' }] })).toBe(false);
		});
		it('robot senders', () => {
			for (const local of ['noreply', 'no-reply', 'donotreply', 'do-not-reply', 'mailer-daemon', 'postmaster', 'bounce', 'bounces', 'notifications']) {
				expect(replies({ from: [{ name: null, email: `${local}@shop.test` }] })).toBe(false);
			}
			expect(replies({ from: [{ name: null, email: 'NoReply+x@shop.test' }] })).toBe(false);
			expect(replies({ from: [{ name: null, email: 'notify-me@shop.test' }] })).toBe(true);
		});
		it('a robot Reply-To', () => {
			expect(replies({ replyTo: [{ name: null, email: 'no-reply@shop.test' }] })).toBe(false);
		});
	});

	it('4. never to the owner’s own addresses, any account or identity', () => {
		expect(replies({ from: [{ name: null, email: 'Other@Mine.test' }] })).toBe(false);
		expect(replies({ from: [{ name: null, email: 'alias@example.test' }] })).toBe(false);
		expect(replies({ replyTo: [{ name: null, email: 'other@mine.test' }] })).toBe(false);
	});

	it('5. only to mail addressed to the account or one of its identities', () => {
		expect(replies({ to: [{ name: null, email: 'list@lists.test' }] })).toBe(false);
		expect(replies({ to: [], cc: [{ name: null, email: 'ALIAS@example.test' }] })).toBe(true);
	});

	it('6. never to spam', () => {
		expect(replies({ keywords: { $junk: true } })).toBe(false);
		expect(replies({ 'header:x-spam-status:asText': 'Yes, score=9.1' })).toBe(false);
		expect(replies({ 'header:x-spam-status:asText': 'No, score=0.1' })).toBe(true);
	});

	it('7. once per sender per day', () => {
		expect(replies({}, { answered: new Set(['bob@outside.test']) })).toBe(false);
	});

	it('8. at most 30 an hour', () => {
		expect(replies({}, { sentLastHour: 29 })).toBe(true);
		expect(replies({}, { sentLastHour: 30 })).toBe(false);
	});
});

describe('the out-of-office window', () => {
	const at = (iso: string) => new Date(iso);

	it('is always on with no dates', () => {
		expect(autoReplyActiveAt(settings(), at('2030-01-01T00:00:00Z'))).toBe(true);
	});

	it('counts the last day whole, in the owner’s time zone', () => {
		// Auckland is 13 hours ahead in November: its 20th ends at 10:59 UTC.
		const s = settings({ until: '2026-11-20', tz: 'Pacific/Auckland' });
		expect(autoReplyActiveAt(s, at('2026-11-20T10:59:00Z'))).toBe(true);
		expect(autoReplyActiveAt(s, at('2026-11-20T11:01:00Z'))).toBe(false);
		// The same moment is still the 20th in UTC.
		expect(autoReplyActiveAt({ ...s, tz: 'UTC' }, at('2026-11-20T11:01:00Z'))).toBe(true);
	});

	it('starts at the start of the first day, in the owner’s time zone', () => {
		// Los Angeles is 8 hours behind: its 21st starts at 08:00 UTC.
		const s = settings({ from: '2026-11-21', tz: 'America/Los_Angeles' });
		expect(autoReplyActiveAt(s, at('2026-11-21T07:59:00Z'))).toBe(false);
		expect(autoReplyActiveAt(s, at('2026-11-21T08:00:00Z'))).toBe(true);
	});

	it('falls back to UTC for a time zone it doesn’t know', () => {
		const s = settings({ until: '2026-11-20', tz: 'Mars/Olympus' });
		expect(autoReplyActiveAt(s, at('2026-11-20T23:59:00Z'))).toBe(true);
		expect(autoReplyActiveAt(s, at('2026-11-21T00:00:00Z'))).toBe(false);
	});
});

describe('the status line', () => {
	it('says each state', () => {
		expect(autoReplyStatus(settings({ enabled: false }), NOW)).toBe('Off');
		expect(autoReplyStatus(settings({ since: '' }), NOW)).toBe('Off');
		expect(autoReplyStatus(settings(), NOW)).toBe('On');
		expect(autoReplyStatus(settings({ from: '2026-11-21' }), NOW)).toBe('Starts 21 Nov');
		expect(autoReplyStatus(settings({ until: '2026-11-28' }), NOW)).toBe('On until 28 Nov');
		expect(autoReplyStatus(settings({ until: '2026-11-19' }), NOW)).toBe('Ended 19 Nov');
	});
});

describe('saving', () => {
	it('checks the dates: real dates, and the end not before the start', () => {
		expect(parseAutoReplyForm({ enabled: true, body: 'x', from: '2026-11-31' })).toEqual({ error: 'The start date isn’t a date.' });
		expect(parseAutoReplyForm({ enabled: true, body: 'x', until: 'soon' })).toEqual({ error: 'The end date isn’t a date.' });
		expect(parseAutoReplyForm({ enabled: true, body: 'x', from: '2026-11-21', until: '2026-11-20' })).toEqual({
			error: 'The end date is before the start date.'
		});
		expect(parseAutoReplyForm({ enabled: true, body: 'x', from: '2026-11-20', until: '2026-11-20', tz: 'Europe/London' })).toEqual({
			form: { enabled: true, subject: '', body: 'x', from: '2026-11-20', until: '2026-11-20', tz: 'Europe/London' }
		});
	});

	it('needs a message to switch on', () => {
		expect(parseAutoReplyForm({ enabled: true, body: ' ' })).toEqual({ error: 'Write the message to send.' });
		expect(parseAutoReplyForm({ enabled: false, body: '' })).toHaveProperty('form');
	});

	it('starts counting from now when switched on or the dates change, and not when only the message does', () => {
		const form = { enabled: true, subject: '', body: 'x', from: '', until: '', tz: 'UTC' };
		const now = '2026-11-20T12:00:00.000Z';
		expect(nextSince(settings({ enabled: false, since: '' }), form, now)).toBe(now);
		expect(nextSince(settings(), { ...form, body: 'changed' }, now)).toBe('2026-11-20T08:00:00.000Z');
		expect(nextSince(settings(), { ...form, until: '2026-11-28' }, now)).toBe(now);
		expect(nextSince(settings(), { ...form, from: '2026-11-21' }, now)).toBe(now);
		expect(nextSince(settings({ since: '' }), form, now)).toBe(now);
		expect(nextSince(settings(), { ...form, enabled: false }, now)).toBe('');
	});
});

// The sending side, against a real database and a fake mail server.

interface Call {
	name: string;
	args: Record<string, unknown>;
	logRows: number;
}
let calls: Call[] = [];
let refuseSubmission = false;

const logRows = () => (getDb().prepare('SELECT COUNT(*) AS n FROM auto_reply_log').get() as { n: number }).n;

const client = {
	request: async (methodCalls: [string, Record<string, unknown>, string][]) => {
		const responses: [string, unknown, string][] = [];
		for (const [name, args, tag] of methodCalls) {
			calls.push({ name, args, logRows: logRows() });
			if (name === 'Identity/get') {
				responses.push([name, { list: [{ id: 'id-me', email: 'me@example.test', name: 'Me' }] }, tag]);
			} else if (name === 'Email/set' && args.create) {
				responses.push([name, { created: { reply: { id: `copy${calls.length}` } } }, tag]);
			} else if (name === 'Email/set') {
				responses.push([name, { destroyed: args.destroy }, tag]);
			} else if (name === 'EmailSubmission/set') {
				responses.push([
					name,
					refuseSubmission ? { notCreated: { sub: { type: 'forbiddenToSend' } } } : { created: { sub: { id: 's1' } } },
					tag
				]);
			} else throw new Error(`unexpected ${name}`);
		}
		return { methodResponses: responses, sessionState: '' };
	}
} as unknown as JMAPClient;

const mailboxes = [
	{ id: 'IN', role: 'inbox' },
	{ id: 'DR', role: 'drafts' }
] as Mailbox[];

const ooo = (over: Partial<AutoReplySettings> = {}): OutOfOffice => ({
	accountRowId: 'acct-1',
	accountEmail: 'me@example.test',
	userId: 'user-1',
	settings: settings(over)
});

const sends = () => calls.filter((c) => c.name === 'EmailSubmission/set');
const hoursAfter = (h: number) => new Date(NOW.getTime() + h * 3_600_000);
const iso = (d: Date) => d.toISOString();

beforeAll(() => {
	runMigrations();
	const db = getDb();
	db.prepare(`INSERT INTO app_user (id, email, password_hash) VALUES ('user-1', 'login@example.test', 'x')`).run();
	db.prepare(
		`INSERT INTO mail_accounts (id, user_id, email, server_url, jmap_account_id, secret_enc)
		 VALUES ('acct-1', 'user-1', 'me@example.test', 'https://mail.example', 'jmap', 'x')`
	).run();
});

beforeEach(() => {
	calls = [];
	refuseSubmission = false;
	getDb().prepare('DELETE FROM auto_reply_log').run();
});

describe('sending a reply', () => {
	it('goes to the right address, with the subject, headers and thread references, and its copy is destroyed', async () => {
		const e = email({ references: ['m0@outside.test'], replyTo: [{ name: 'Desk', email: 'desk@outside.test' }] });
		await answerNewMail(client, 'jmap', ooo(), [e], mailboxes, NOW);

		const create = calls.find((c) => c.name === 'Email/set')!.args.create as Record<string, Record<string, unknown>>;
		expect(create.reply).toMatchObject({
			mailboxIds: { DR: true },
			from: [{ name: 'Me', email: 'me@example.test' }],
			to: [{ name: 'Desk', email: 'desk@outside.test' }],
			subject: 'Automatic reply: Lunch?',
			bodyValues: { text: { value: 'I am away until Monday.' } },
			textBody: [{ partId: 'text', type: 'text/plain' }],
			'header:Auto-Submitted:asText': 'auto-replied',
			'header:X-Auto-Response-Suppress:asText': 'All',
			inReplyTo: ['m1@outside.test'],
			references: ['m0@outside.test', 'm1@outside.test']
		});
		expect(create.reply).not.toHaveProperty('htmlBody');
		expect(sends()[0].args).toMatchObject({
			create: { sub: { emailId: '#reply', identityId: 'id-me', envelope: { mailFrom: { email: 'me@example.test' }, rcptTo: [{ email: 'desk@outside.test' }] } } },
			onSuccessDestroyEmail: ['#sub']
		});
	});

	it('uses the saved subject when there is one', async () => {
		await answerNewMail(client, 'jmap', ooo({ subject: 'Out of office' }), [email()], mailboxes, NOW);
		const create = calls.find((c) => c.name === 'Email/set')!.args.create as Record<string, Record<string, unknown>>;
		expect(create.reply.subject).toBe('Out of office');
	});

	it('is logged before it is sent', async () => {
		await answerNewMail(client, 'jmap', ooo(), [email()], mailboxes, NOW);
		expect(calls.find((c) => c.name === 'Email/set')!.logRows).toBe(1);
		expect(logRows()).toBe(1);
	});

	it('removes the log row when the send fails, and destroys the unsent copy', async () => {
		refuseSubmission = true;
		await answerNewMail(client, 'jmap', ooo(), [email()], mailboxes, NOW);
		expect(logRows()).toBe(0);
		expect(calls.at(-1)).toMatchObject({ name: 'Email/set', args: { destroy: ['copy2'] } });
	});
});

describe('one reply per sender per day', () => {
	it('answers the first message, not a second the same day, and again the next day', async () => {
		await answerNewMail(client, 'jmap', ooo(), [email({ id: 'a' })], mailboxes, NOW);
		expect(sends()).toHaveLength(1);

		const later = hoursAfter(5);
		await answerNewMail(client, 'jmap', ooo(), [email({ id: 'b', receivedAt: iso(hoursAfter(4)) })], mailboxes, later);
		expect(sends()).toHaveLength(1);

		const nextDay = hoursAfter(25);
		await answerNewMail(client, 'jmap', ooo(), [email({ id: 'c', receivedAt: iso(hoursAfter(24.5)) })], mailboxes, nextDay);
		expect(sends()).toHaveLength(2);
	});

	it('within one batch too', async () => {
		await answerNewMail(client, 'jmap', ooo(), [email({ id: 'a' }), email({ id: 'b' })], mailboxes, NOW);
		expect(sends()).toHaveLength(1);
	});
});

describe('the hourly cap', () => {
	const fromMany = (n: number, offset = 0) =>
		Array.from({ length: n }, (_, i) => email({ id: `x${i + offset}`, from: [{ name: null, email: `p${i + offset}@outside.test` }] }));

	it('stops at 30 replies an hour, across runs', async () => {
		await answerNewMail(client, 'jmap', ooo(), fromMany(20), mailboxes, NOW);
		await answerNewMail(client, 'jmap', ooo(), fromMany(20, 20), mailboxes, hoursAfter(0.5));
		expect(sends()).toHaveLength(30);

		// An hour after the first ones, there is room again.
		await answerNewMail(client, 'jmap', ooo(), fromMany(1, 40).map((e) => ({ ...e, receivedAt: iso(hoursAfter(1)) })), mailboxes, hoursAfter(1.01));
		expect(sends()).toHaveLength(31);
	});
});

describe('the account’s out-of-office', () => {
	it('is on for the account when its login’s setting is active', () => {
		patchPrefs('user-1', { auto_reply_enabled: 'on', auto_reply_body: 'Away', auto_reply_since: iso(NOW) });
		expect(outOfOfficeFor('me@example.test', NOW)).toMatchObject({ accountRowId: 'acct-1', userId: 'user-1' });
		patchPrefs('user-1', { auto_reply_until: '2026-11-19' });
		expect(outOfOfficeFor('me@example.test', NOW)).toBeNull();
		patchPrefs('user-1', { auto_reply_until: undefined, auto_reply_enabled: 'off' });
		expect(outOfOfficeFor('me@example.test', NOW)).toBeNull();
		expect(outOfOfficeFor('nobody@example.test', NOW)).toBeNull();
	});

	it('keeps its log a month', () => {
		const db = getDb();
		const add = db.prepare(`INSERT INTO auto_reply_log (account_id, sender, sent_at, email_id) VALUES ('acct-1', ?, ?, 'e')`);
		add.run('old@outside.test', iso(new Date(NOW.getTime() - 31 * 86_400_000)));
		add.run('new@outside.test', iso(new Date(NOW.getTime() - 29 * 86_400_000)));
		pruneOldAutoReplies(NOW);
		expect(db.prepare('SELECT sender FROM auto_reply_log').all()).toEqual([{ sender: 'new@outside.test' }]);
	});
});
