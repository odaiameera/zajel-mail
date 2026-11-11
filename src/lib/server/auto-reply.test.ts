import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'zajel-auto-reply-')), 'test.db');

import { getDb } from './db/index';
import { runMigrations } from './db/migrate';
import { patchPrefs } from './db/queries/app-prefs';
import {
	AUTO_REPLY_PROPERTIES,
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
import { JMAPMethodError, type JMAPClient } from '$lib/jmap/client';
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

	it('answers the From address even when there is a Reply-To (A1)', () => {
		expect(decide({ replyTo: [{ name: 'Desk', email: 'desk@outside.test' }] })).toEqual({
			to: { name: 'Bob', email: 'Bob@Outside.test' },
			sender: 'bob@outside.test'
		});
		// A team list as Reply-To changes nothing either.
		expect(decide({ replyTo: [{ name: null, email: 'all-staff@outside.test' }] })).toMatchObject({ to: { email: 'Bob@Outside.test' } });
	});

	it('reads the headers it needs to decide', () => {
		expect(AUTO_REPLY_PROPERTIES).toEqual(
			expect.arrayContaining([
				'header:authentication-results:asText:all',
				'header:return-path:asText',
				'header:content-type:asText',
				'header:from:asGroupedAddresses'
			])
		);
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
		it('delivery reports: an empty Return-Path', () => {
			expect(replies({ 'header:return-path:asText': '<>' })).toBe(false);
			expect(replies({ 'header:return-path:asText': ' < > ' })).toBe(false);
			expect(replies({ 'header:return-path:asText': '' })).toBe(false);
			expect(replies({ 'header:return-path:asText': '<bob@x.test>' })).toBe(true);
		});
		it('delivery reports and read receipts: multipart/report', () => {
			expect(replies({ 'header:content-type:asText': 'multipart/report; report-type=disposition-notification; boundary="b"' })).toBe(false);
			expect(replies({ 'header:content-type:asText': 'Multipart/Report; report-type=delivery-status' })).toBe(false);
			expect(replies({ 'header:content-type:asText': 'multipart/alternative; boundary="b"' })).toBe(true);
		});
	});

	describe('3. never to a missing or robot address', () => {
		const desk = [{ name: null, email: 'desk@outside.test' }];
		it('no sender address, even with a Reply-To (A3)', () => {
			expect(replies({ from: null })).toBe(false);
			expect(replies({ from: null, replyTo: desk })).toBe(false);
			expect(replies({ from: [], replyTo: desk })).toBe(false);
			expect(replies({ from: [{ name: 'Nobody', email: '' }] })).toBe(false);
			expect(replies({ from: [{ name: 'Nobody', email: 'nobody' }], replyTo: desk })).toBe(false);
		});
		it('two sender addresses, even with a Reply-To (A3)', () => {
			const two = [
				{ name: 'Bob', email: 'bob@outside.test' },
				{ name: 'Ann', email: 'ann@outside.test' }
			];
			expect(replies({ from: two })).toBe(false);
			expect(replies({ from: two, replyTo: desk })).toBe(false);
		});
		it('a group as sender', () => {
			const bob = { name: 'Bob', email: 'bob@outside.test' };
			expect(replies({ from: [bob], 'header:from:asGroupedAddresses': [{ name: 'Team', addresses: [bob] }] })).toBe(false);
			expect(replies({ from: [bob], 'header:from:asGroupedAddresses': [{ name: null, addresses: [bob] }] })).toBe(true);
		});
		it('robot senders', () => {
			for (const local of ['noreply', 'no-reply', 'donotreply', 'do-not-reply', 'mailer-daemon', 'postmaster', 'bounce', 'bounces', 'notifications']) {
				expect(replies({ from: [{ name: null, email: `${local}@shop.test` }] })).toBe(false);
			}
			expect(replies({ from: [{ name: null, email: 'NoReply+x@shop.test' }] })).toBe(false);
			expect(replies({ from: [{ name: null, email: 'notify-me@shop.test' }] })).toBe(true);
		});
		for (const address of ['no_reply@x.test', 'noreply-billing@x.test', 'bounce-12345@x.test', 'notification@x.test', 'alerts@x.test', 'do_not_reply@x.test', 'postmaster+x@x.test']) {
			it(`robot sender ${address}`, () => {
				expect(replies({ from: [{ name: null, email: address }] })).toBe(false);
			});
		}
		it('a sender that failed authentication (A4)', () => {
			const auth = (v: string) => ({ 'header:authentication-results:asText:all': [v] });
			expect(replies(auth('mx.example.test; spf=pass smtp.mailfrom=outside.test; dmarc=fail header.from=outside.test'))).toBe(false);
			expect(replies(auth('mx.example.test; spf=pass; dkim=pass; dmarc=pass header.from=outside.test'))).toBe(true);
			expect(replies({ 'header:authentication-results:asText:all': null })).toBe(true);
		});
		it('never a robot Reply-To instead, nor a person one for a robot From', () => {
			expect(decide({ replyTo: [{ name: null, email: 'no-reply@shop.test' }] })).toMatchObject({ to: { email: 'Bob@Outside.test' } });
			expect(replies({ from: [{ name: null, email: 'noreply@shop.test' }], replyTo: desk })).toBe(false);
		});
	});

	it('4. never to the owner’s own addresses, any account or identity', () => {
		expect(replies({ from: [{ name: null, email: 'Other@Mine.test' }] })).toBe(false);
		expect(replies({ from: [{ name: null, email: 'alias@example.test' }] })).toBe(false);
		// An own address as Reply-To is not where the reply goes, so it doesn't matter.
		expect(replies({ replyTo: [{ name: null, email: 'other@mine.test' }] })).toBe(true);
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
/** How the fake server treats the copy and the submission. */
let copyMode: 'ok' | 'notCreated' | 'methodError' = 'ok';
let submitMode: 'ok' | 'notCreated' | 'methodError' | 'lostBeforeSend' | 'lostAfterSend' = 'ok';
/** Copies in Drafts, and the addresses mail was actually sent to. */
let copies = new Set<string>();
let delivered: string[] = [];
let nextCopy = 0;

const logRows = () => (getDb().prepare('SELECT COUNT(*) AS n FROM auto_reply_log').get() as { n: number }).n;

const client = {
	request: async (methodCalls: [string, Record<string, unknown>, string][]) => {
		const responses: [string, unknown, string][] = [];
		let lost = false;
		for (const [name, args, tag] of methodCalls) {
			calls.push({ name, args, logRows: logRows() });
			if (name === 'Identity/get') {
				responses.push([name, { list: [{ id: 'id-me', email: 'me@example.test', name: 'Me' }] }, tag]);
			} else if (name === 'Email/set' && args.create) {
				// As JMAPClient.request does on a method-level error.
				if (copyMode === 'methodError') throw new JMAPMethodError('forbidden', 'no');
				if (copyMode === 'notCreated') {
					responses.push([name, { notCreated: { reply: { type: 'overQuota' } } }, tag]);
					continue;
				}
				const id = `copy${++nextCopy}`;
				copies.add(id);
				responses.push([name, { created: { reply: { id } } }, tag]);
			} else if (name === 'Email/set') {
				for (const id of args.destroy as string[]) copies.delete(id);
				responses.push([name, { destroyed: args.destroy }, tag]);
			} else if (name === 'EmailSubmission/set') {
				if (submitMode === 'methodError') throw new JMAPMethodError('forbidden', 'no');
				if (submitMode === 'lostBeforeSend') throw new Error('fetch failed: connect ECONNRESET');
				if (submitMode === 'notCreated') {
					responses.push([name, { notCreated: { sub: { type: 'forbiddenToSend' } } }, tag]);
					continue;
				}
				const sub = (args.create as { sub: { emailId: string; envelope: { rcptTo: { email: string }[] } } }).sub;
				delivered.push(...sub.envelope.rcptTo.map((r) => r.email));
				copies.delete(sub.emailId); // onSuccessDestroyEmail
				responses.push([name, { created: { sub: { id: 's1' } } }, tag]);
				// The server sent it, then the answer is lost on the way back.
				if (submitMode === 'lostAfterSend') lost = true;
			} else throw new Error(`unexpected ${name}`);
		}
		if (lost) throw new Error('fetch failed: socket hang up');
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
	db.prepare(`INSERT INTO app_user (id, email, password_hash) VALUES ('user-2', 'someone@example.test', 'x')`).run();
	const account = db.prepare(
		`INSERT INTO mail_accounts (id, user_id, email, server_url, jmap_account_id, secret_enc)
		 VALUES (?, ?, ?, 'https://mail.example', 'jmap', 'x')`
	);
	account.run('acct-1', 'user-1', 'me@example.test');
	// A second address of the same login, and an account of another login.
	account.run('acct-2', 'user-1', 'me@second.test');
	account.run('acct-3', 'user-2', 'them@example.test');
});

beforeEach(() => {
	calls = [];
	copyMode = 'ok';
	submitMode = 'ok';
	copies = new Set();
	delivered = [];
	nextCopy = 0;
	getDb().prepare('DELETE FROM auto_reply_log').run();
});

describe('sending a reply', () => {
	it('goes to the sender, with the subject, headers and thread references, and its copy is destroyed', async () => {
		const e = email({ references: ['m0@outside.test'], replyTo: [{ name: 'Desk', email: 'victim@third.test' }] });
		await answerNewMail(client, 'jmap', ooo(), [e], mailboxes, NOW);

		const create = calls.find((c) => c.name === 'Email/set')!.args.create as Record<string, Record<string, unknown>>;
		expect(create.reply).toMatchObject({
			mailboxIds: { DR: true },
			from: [{ name: 'Me', email: 'me@example.test' }],
			to: [{ name: 'Bob', email: 'Bob@Outside.test' }],
			subject: 'Automatic reply: Lunch?',
			bodyValues: { text: { value: 'I am away until Monday.' } },
			textBody: [{ partId: 'text', type: 'text/plain' }],
			'header:Auto-Submitted:asText': 'auto-replied',
			'header:X-Auto-Response-Suppress:asText': 'All',
			inReplyTo: ['m1@outside.test'],
			references: ['m0@outside.test', 'm1@outside.test']
		});
		expect(create.reply).not.toHaveProperty('htmlBody');
		// The copy is made in a request of its own, so its id is known for the submission.
		expect(calls.map((c) => c.name)).toEqual(['Identity/get', 'Email/set', 'EmailSubmission/set']);
		expect(sends()[0].args).toMatchObject({
			create: { sub: { emailId: 'copy1', identityId: 'id-me', envelope: { mailFrom: { email: 'me@example.test' }, rcptTo: [{ email: 'Bob@Outside.test' }] } } },
			onSuccessDestroyEmail: ['#sub']
		});
		// A1: nothing ever goes to the Reply-To.
		expect(delivered).toEqual(['Bob@Outside.test']);
		expect(copies.size).toBe(0);
		expect(getDb().prepare('SELECT sender FROM auto_reply_log').all()).toEqual([{ sender: 'bob@outside.test' }]);
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

	it('A2: forty senders sharing one Reply-To send nothing to it', async () => {
		const flood = Array.from({ length: 40 }, (_, i) =>
			email({ id: `f${i}`, from: [{ name: null, email: `spoof${i}@evil.test` }], replyTo: [{ name: null, email: 'victim@third.test' }] })
		);
		await answerNewMail(client, 'jmap', ooo(), flood, mailboxes, NOW);
		expect(delivered).toHaveLength(30);
		expect(delivered).not.toContain('victim@third.test');
		expect(calls.some((c) => JSON.stringify(c.args).includes('victim@third.test'))).toBe(false);
	});
});

describe('when the server refuses or doesn’t answer', () => {
	const later = new Date(NOW.getTime() + 60_000);
	const second = () => email({ id: 'e2', receivedAt: '2026-11-20T11:30:00Z' });

	it('B1: a lost answer after sending keeps the log row, so the sender gets no second reply that day', async () => {
		submitMode = 'lostAfterSend';
		await answerNewMail(client, 'jmap', ooo(), [email()], mailboxes, NOW);
		expect(logRows()).toBe(1);
		submitMode = 'ok';
		await answerNewMail(client, 'jmap', ooo(), [second()], mailboxes, later);
		expect(delivered).toEqual(['Bob@Outside.test']);
	});

	it('B1: a reset connection keeps the log row too', async () => {
		submitMode = 'lostBeforeSend';
		await answerNewMail(client, 'jmap', ooo(), [email()], mailboxes, NOW);
		expect(logRows()).toBe(1);
		submitMode = 'ok';
		await answerNewMail(client, 'jmap', ooo(), [second()], mailboxes, later);
		expect(delivered).toEqual([]);
	});

	it('B2/C1: a refused submission removes the log row and the copy, and a later message is answered', async () => {
		submitMode = 'notCreated';
		await answerNewMail(client, 'jmap', ooo(), [email()], mailboxes, NOW);
		expect(logRows()).toBe(0);
		expect(calls.at(-1)).toMatchObject({ name: 'Email/set', args: { destroy: ['copy1'] } });
		expect(copies.size).toBe(0);
		submitMode = 'ok';
		await answerNewMail(client, 'jmap', ooo(), [second()], mailboxes, later);
		expect(delivered).toEqual(['Bob@Outside.test']);
	});

	it('B3/C1: a method-level error on the submission removes the log row and the copy', async () => {
		submitMode = 'methodError';
		await answerNewMail(client, 'jmap', ooo(), [email()], mailboxes, NOW);
		await answerNewMail(client, 'jmap', ooo(), [second()], mailboxes, later);
		expect(logRows()).toBe(0);
		expect(copies.size).toBe(0);
	});

	it('C2: a submission that throws still has its copy destroyed', async () => {
		submitMode = 'lostBeforeSend';
		await answerNewMail(client, 'jmap', ooo(), [email()], mailboxes, NOW);
		expect(calls.at(-1)).toMatchObject({ name: 'Email/set', args: { destroy: ['copy1'] } });
		expect(copies.size).toBe(0);
	});

	it('C3: a refused copy means no submission, no copy, no log row', async () => {
		for (const mode of ['notCreated', 'methodError'] as const) {
			copyMode = mode;
			await answerNewMail(client, 'jmap', ooo(), [email()], mailboxes, NOW);
			expect(sends()).toEqual([]);
			expect(copies.size).toBe(0);
			expect(logRows()).toBe(0);
		}
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

	it('A5: whatever the case of the address', async () => {
		await answerNewMail(client, 'jmap', ooo(), [email({ id: 'a', from: [{ name: null, email: 'Bob@Example.com' }] })], mailboxes, NOW);
		await answerNewMail(client, 'jmap', ooo(), [email({ id: 'b', from: [{ name: null, email: 'bob@example.com' }] })], mailboxes, hoursAfter(0.1));
		expect(delivered).toEqual(['Bob@Example.com']);
	});

	const second: OutOfOffice = { ...ooo(), accountRowId: 'acct-2', accountEmail: 'me@second.test' };
	const toBoth = email({ to: [{ name: null, email: 'me@example.test' }, { name: null, email: 'me@second.test' }] });

	it('E1: across the login’s accounts, so mail to two of its addresses gets one reply', async () => {
		await answerNewMail(client, 'jmap', ooo(), [toBoth], mailboxes, NOW);
		await answerNewMail(client, 'jmap', second, [toBoth], mailboxes, NOW);
		expect(delivered).toHaveLength(1);
	});

	it('E1: even when both accounts decided before either logged its reply', async () => {
		// Both runs read the log before either writes: the claim itself refuses the second.
		await Promise.all([
			answerNewMail(client, 'jmap', ooo(), [toBoth], mailboxes, NOW),
			answerNewMail(client, 'jmap', second, [toBoth], mailboxes, NOW)
		]);
		expect(delivered).toHaveLength(1);
	});

	it('E3: another login answers the same sender as usual', async () => {
		const theirs: OutOfOffice = { ...ooo(), accountRowId: 'acct-3', accountEmail: 'them@example.test', userId: 'user-2' };
		await answerNewMail(client, 'jmap', ooo(), [email()], mailboxes, NOW);
		await answerNewMail(client, 'jmap', theirs, [email({ to: [{ name: null, email: 'them@example.test' }] })], mailboxes, NOW);
		expect(delivered).toHaveLength(2);
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

	it('E2: is the login’s, so another of its accounts sends none once one has sent 30', async () => {
		await answerNewMail(client, 'jmap', ooo(), fromMany(30), mailboxes, NOW);
		const second: OutOfOffice = { ...ooo(), accountRowId: 'acct-2', accountEmail: 'me@second.test' };
		const toSecond = fromMany(5, 30).map((e) => ({ ...e, to: [{ name: null, email: 'me@second.test' }] }));
		await answerNewMail(client, 'jmap', second, toSecond, mailboxes, hoursAfter(0.5));
		expect(sends()).toHaveLength(30);

		// E3: another login's account is not held back by it.
		const theirs: OutOfOffice = { ...ooo(), accountRowId: 'acct-3', accountEmail: 'them@example.test', userId: 'user-2' };
		const toThem = fromMany(5, 40).map((e) => ({ ...e, to: [{ name: null, email: 'them@example.test' }] }));
		await answerNewMail(client, 'jmap', theirs, toThem, mailboxes, hoursAfter(0.5));
		expect(sends()).toHaveLength(35);
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
