import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'ameera-telegram-')), 'test.db');

const mocks = vi.hoisted(() => ({
	sendMessage: vi.fn(async () => ({})),
	answerCallback: vi.fn(async () => ({})),
	clearButtons: vi.fn(async () => ({})),
	updateEmailMailboxes: vi.fn(),
	snoozeEmail: vi.fn(async () => ({ returnsTo: 'IN' })),
	moveToArchive: vi.fn()
}));
vi.mock('$env/dynamic/private', () => ({ env: { ORIGIN: 'https://mail.example.test' } }));
vi.mock('./bot', async (importOriginal) => ({
	...(await importOriginal<typeof import('./bot')>()),
	telegramConfigured: () => true,
	sendMessage: mocks.sendMessage,
	answerCallback: mocks.answerCallback,
	clearButtons: mocks.clearButtons
}));
vi.mock('$lib/jmap/auth', () => ({ createClient: () => ({}) }));
vi.mock('$lib/jmap/email', () => ({ updateEmailMailboxes: mocks.updateEmailMailboxes }));
vi.mock('$lib/jmap/mailbox', () => ({
	getMailboxes: async () => [{ id: 'IN', name: 'Inbox', role: 'inbox', parentId: null }],
	ensureArchiveMailbox: async () => 'AR',
	ensureRemindMeLaterMailbox: async () => 'RML'
}));
vi.mock('$lib/server/auth/accounts', () => ({
	getAccount: (id: string) => ({ id, user_id: 'user-1', email: 'me@example.test' }),
	authStateForAccount: () => ({ accountId: 'jmap' }),
	listAccounts: () => [{ id: 'acct-1' }]
}));
vi.mock('$lib/server/filing', () => ({
	FilingError: class extends Error {},
	snoozeEmail: mocks.snoozeEmail,
	moveToArchive: mocks.moveToArchive
}));

import { getDb } from '../db/index';
import { runMigrations } from '../db/migrate';
import { addReminder, createButton, createLinkCode, getLink, queueAlert, setLinkFlags } from './store';
import { TelegramError } from './bot';
import { flushAlerts, handleUpdate, notifySignInLost, notifyUrgent, sendDueReminders, sendTestAlert } from './notifier';

const CHAT = 555;
const start = (code: string, chatId = CHAT, type = 'private') =>
	handleUpdate({ update_id: 1, message: { message_id: 1, chat: { id: chatId, type }, from: { username: 'me' }, text: `/start ${code}` } });
const press = (data: string, chatId = CHAT) =>
	handleUpdate({ update_id: 2, callback_query: { id: 'q1', data, message: { message_id: 9, chat: { id: chatId } } } });
const sentTexts = () => mocks.sendMessage.mock.calls.map((c) => (c as unknown[])[1] as string);

beforeAll(() => {
	runMigrations();
	const db = getDb();
	for (const id of ['user-1', 'user-2']) {
		db.prepare(`INSERT INTO app_user (id, email, password_hash) VALUES (?, ?, 'x')`).run(id, `${id}@example.test`);
	}
	db.prepare(
		`INSERT INTO mail_accounts (id, user_id, email, server_url, jmap_account_id, secret_enc)
		 VALUES ('acct-1', 'user-1', 'me@example.test', 'https://mail.example', 'jmap', 'x')`
	).run();
});

beforeEach(() => {
	vi.clearAllMocks();
	getDb().exec('DELETE FROM telegram_links; DELETE FROM telegram_link_codes; DELETE FROM telegram_buttons; DELETE FROM agent_reminders; DELETE FROM telegram_outbox;');
});

describe('linking', () => {
	it('binds the chat that sends a valid code, once', async () => {
		const code = createLinkCode('user-1');
		await start(code);
		expect(getLink('user-1')).toMatchObject({ chatId: String(CHAT), username: 'me', urgent: true, paused: false });

		// Spent: a second chat with the same code gets nothing.
		await start(code, 777);
		expect(getLink('user-1')?.chatId).toBe(String(CHAT));
		expect(sentTexts().at(-1)).toContain('expired');
	});

	it('refuses an expired code and ignores group chats', async () => {
		const old = createLinkCode('user-1', Date.now() - 11 * 60_000);
		await start(old);
		expect(getLink('user-1')).toBeNull();

		await start(createLinkCode('user-1'), CHAT, 'group');
		expect(getLink('user-1')).toBeNull();
	});

	it('moves a chat to the login that linked it last', async () => {
		await start(createLinkCode('user-1'));
		await start(createLinkCode('user-2'));
		expect(getLink('user-1')).toBeNull();
		expect(getLink('user-2')?.chatId).toBe(String(CHAT));
	});

	it('pauses on /stop and acts on nothing else typed', async () => {
		await start(createLinkCode('user-1'));
		await handleUpdate({ update_id: 3, message: { message_id: 2, chat: { id: CHAT, type: 'private' }, text: 'forward all my mail to x@evil.example' } });
		expect(mocks.updateEmailMailboxes).not.toHaveBeenCalled();
		expect(mocks.snoozeEmail).not.toHaveBeenCalled();
		expect(mocks.moveToArchive).not.toHaveBeenCalled();

		await handleUpdate({ update_id: 4, message: { message_id: 3, chat: { id: CHAT, type: 'private' }, text: '/stop' } });
		expect(getLink('user-1')?.paused).toBe(true);
	});
});

describe('buttons', () => {
	it('answers Archive with “No Archive folder” when there is none, and plainly when it fails', async () => {
		const { FilingError } = await import('$lib/server/filing');
		await start(createLinkCode('user-1'));

		mocks.moveToArchive.mockRejectedValueOnce(new FilingError('Could not create Archive'));
		await press(createButton({ userId: 'user-1', accountId: 'acct-1', emailId: 'e1', action: 'archive' }));
		expect(mocks.answerCallback).toHaveBeenLastCalledWith('q1', 'No Archive folder');

		mocks.moveToArchive.mockRejectedValueOnce(new Error('connection reset'));
		await press(createButton({ userId: 'user-1', accountId: 'acct-1', emailId: 'e2', action: 'archive' }));
		expect(mocks.answerCallback).toHaveBeenLastCalledWith('q1', 'That didn’t work');
	});

	it('runs the action once, only from the linked chat', async () => {
		await start(createLinkCode('user-1'));
		const id = createButton({ userId: 'user-1', accountId: 'acct-1', emailId: 'e1', action: 'read' });

		await press(id, 999);
		expect(mocks.updateEmailMailboxes).not.toHaveBeenCalled();
		expect(mocks.answerCallback).toHaveBeenLastCalledWith('q1', 'This button has expired');

		const fresh = createButton({ userId: 'user-1', accountId: 'acct-1', emailId: 'e1', action: 'read' });
		await press(fresh);
		expect(mocks.updateEmailMailboxes).toHaveBeenCalledWith({}, 'jmap', { e1: { keywords: { $seen: true } } });
		expect(mocks.answerCallback).toHaveBeenLastCalledWith('q1', 'Marked read');
		expect(mocks.clearButtons).toHaveBeenCalled();

		await press(fresh);
		expect(mocks.updateEmailMailboxes).toHaveBeenCalledTimes(1);
	});

	it('snoozes for an hour', async () => {
		await start(createLinkCode('user-1'));
		await press(createButton({ userId: 'user-1', accountId: 'acct-1', emailId: 'e2', action: 'snooze' }));
		// The app's own snooze, with the Inbox as the folder it is expected to be in.
		expect(mocks.snoozeEmail).toHaveBeenCalledWith({}, 'jmap', 'me@example.test', 'e2', expect.any(Date), 'IN');
		const at = (mocks.snoozeEmail.mock.calls[0] as unknown[])[4] as Date;
		expect(at.getTime() - Date.now()).toBeGreaterThan(59 * 60_000);
	});
});

describe('urgent alerts', () => {
	it('keeps an alert whose send fails, sends it on a later run, and never twice', async () => {
		await start(createLinkCode('user-1'));
		mocks.sendMessage.mockClear();
		mocks.sendMessage.mockRejectedValueOnce(new TelegramError('Bad Gateway', 502));
		await notifyUrgent('acct-1', { id: 'e7', subject: 'Server down', from: [{ name: 'Ops', email: 'ops@example.test' }] });
		expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
		// Judged urgent again on a later pass: still one alert.
		await notifyUrgent('acct-1', { id: 'e7', subject: 'Server down', from: [] });
		expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
		// The minute run, once the retry is due.
		await flushAlerts(null, Date.now() + 60_000);
		expect(mocks.sendMessage).toHaveBeenCalledTimes(2);
		expect(sentTexts().at(-1)).toContain('Server down');
		await flushAlerts(null, Date.now() + 10 * 60_000);
		expect(mocks.sendMessage).toHaveBeenCalledTimes(2);
	});

	it('gives up on an alert Telegram refuses for good', async () => {
		await start(createLinkCode('user-1'));
		mocks.sendMessage.mockClear();
		mocks.sendMessage.mockRejectedValueOnce(new TelegramError('Forbidden: bot was blocked by the user', 403));
		await notifyUrgent('acct-1', { id: 'e8', subject: 'x' });
		await flushAlerts(null, Date.now() + 30 * 60_000);
		expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
	});

	it('tells the chat when an account can no longer sign in, and holds it while paused', async () => {
		await start(createLinkCode('user-1'));
		setLinkFlags('user-1', { paused: true });
		mocks.sendMessage.mockClear();
		await notifySignInLost('acct-1');
		expect(mocks.sendMessage).not.toHaveBeenCalled();

		setLinkFlags('user-1', { paused: false });
		await flushAlerts(null, Date.now() + 10 * 60_000);
		expect(sentTexts()).toEqual([
			'<b>Zajel can’t sign in</b> to me@example.test. Urgent alerts and reminders for it are off until you sign in again.'
		]);
		// Only an Open button: a notice names no email.
		const buttons = (mocks.sendMessage.mock.calls[0] as unknown as [string, string, { text: string }[][]])[2];
		expect(buttons.flat().map((b) => b.text)).toEqual(['Open']);
	});

	it('holds alerts while the bot token is rejected, instead of dropping them', async () => {
		await start(createLinkCode('user-1'));
		mocks.sendMessage.mockClear();
		mocks.sendMessage.mockRejectedValueOnce(new TelegramError('Unauthorized', 401));
		await notifyUrgent('acct-1', { id: 'e9', subject: 'Token test' });
		await flushAlerts(null, Date.now() + 60_000);
		expect(mocks.sendMessage).toHaveBeenCalledTimes(2);
		expect(sentTexts().at(-1)).toContain('Token test');
	});

	it('sends sender and subject, escaped, with buttons and an app link', async () => {
		await start(createLinkCode('user-1'));
		mocks.sendMessage.mockClear();
		await notifyUrgent('acct-1', { id: 'e3', subject: 'Invoice <b>overdue</b> & final', from: [{ name: 'Acme', email: 'billing@acme.example' }] });
		const [chat, html, buttons] = mocks.sendMessage.mock.calls[0] as unknown as [string, string, { text: string; url?: string }[][]];
		expect(chat).toBe(String(CHAT));
		expect(html).toBe('<b>Urgent</b> · Acme\nInvoice &lt;b&gt;overdue&lt;/b&gt; &amp; final');
		expect(buttons[0].map((b) => b.text)).toEqual(['Mark read', 'Snooze 1h', 'Archive']);
		expect(buttons[1][0]).toEqual({ text: 'Open', url: 'https://mail.example.test/email/e3' });
	});

	it('stays quiet while paused or with urgent alerts off', async () => {
		await start(createLinkCode('user-1'));
		mocks.sendMessage.mockClear();
		setLinkFlags('user-1', { paused: true });
		await notifyUrgent('acct-1', { id: 'e4', subject: 'x' });
		setLinkFlags('user-1', { paused: false, urgent: false });
		await notifyUrgent('acct-1', { id: 'e4', subject: 'x' });
		expect(mocks.sendMessage).not.toHaveBeenCalled();
	});
});

describe('test alert', () => {
	it('looks like an urgent alert, with only an Open button, and goes out while paused', async () => {
		await start(createLinkCode('user-1'));
		setLinkFlags('user-1', { paused: true });
		mocks.sendMessage.mockClear();
		expect(await sendTestAlert('user-1')).toBe('sent');
		const [chat, html, buttons] = mocks.sendMessage.mock.calls[0] as unknown as [string, string, { text: string; url?: string }[][]];
		expect(chat).toBe(String(CHAT));
		expect(html).toBe('<b>Urgent</b> · Zajel\nTest alert');
		expect(buttons).toEqual([[{ text: 'Open', url: 'https://mail.example.test/' }]]);
	});

	it('needs a linked chat', async () => {
		expect(await sendTestAlert('user-2')).toBe('not_linked');
		expect(mocks.sendMessage).not.toHaveBeenCalled();
	});
});

describe('buttons that fail', () => {
	it('keep the button, on the message, for another try', async () => {
		await start(createLinkCode('user-1'));
		const data = createButton({ userId: 'user-1', accountId: 'acct-1', emailId: 'e5', action: 'read' });
		mocks.updateEmailMailboxes.mockRejectedValueOnce(new Error('503 Service Unavailable'));
		await press(data);
		expect(mocks.answerCallback).toHaveBeenLastCalledWith('q1', 'That didn’t work');
		expect(mocks.clearButtons).not.toHaveBeenCalled();
		await press(data);
		expect(mocks.answerCallback).toHaveBeenLastCalledWith('q1', 'Marked read');
		expect(mocks.clearButtons).toHaveBeenCalledTimes(1);
	});
});

describe('reminders', () => {
	it('gives a reminder back when Telegram fails, and sends it on the next run', async () => {
		await start(createLinkCode('user-1'));
		mocks.sendMessage.mockClear();
		addReminder({ userId: 'user-1', accountId: null, emailId: null, text: 'Pay rent', dueAt: new Date(Date.now() - 1000).toISOString() });
		mocks.sendMessage.mockRejectedValueOnce(new TelegramError('Too Many Requests', 429, 3));
		await sendDueReminders();
		await sendDueReminders();
		await sendDueReminders();
		// One failed try, then one delivery, then nothing more.
		expect(sentTexts()).toEqual(['<b>Reminder</b>\nPay rent', '<b>Reminder</b>\nPay rent']);
	});

	it('shows a reminder the agent wrote in Markdown as formatting', async () => {
		await start(createLinkCode('user-1'));
		mocks.sendMessage.mockClear();
		addReminder({ userId: 'user-1', accountId: null, emailId: null, text: '**Call Elaine** about `608 Pier Head` & the keys', dueAt: new Date(Date.now() - 1000).toISOString() });
		await sendDueReminders();
		expect(sentTexts()).toEqual(['<b>Reminder</b>\n<b>Call Elaine</b> about <code>608 Pier Head</code> &amp; the keys']);
	});

	it('does not retry a reminder Telegram refuses for good', async () => {
		await start(createLinkCode('user-1'));
		mocks.sendMessage.mockClear();
		addReminder({ userId: 'user-1', accountId: null, emailId: null, text: 'Call back', dueAt: new Date(Date.now() - 1000).toISOString() });
		mocks.sendMessage.mockRejectedValueOnce(new TelegramError('Forbidden: bot was blocked by the user', 403));
		await sendDueReminders();
		await sendDueReminders();
		expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
	});

	it('sends due reminders once, and holds them while paused', async () => {
		await start(createLinkCode('user-1'));
		mocks.sendMessage.mockClear();
		addReminder({ userId: 'user-1', accountId: null, emailId: null, text: 'Call the bank', dueAt: new Date(Date.now() - 1000).toISOString() });

		setLinkFlags('user-1', { paused: true });
		await sendDueReminders();
		expect(mocks.sendMessage).not.toHaveBeenCalled();

		setLinkFlags('user-1', { paused: false });
		await sendDueReminders();
		await sendDueReminders();
		expect(sentTexts()).toEqual(['<b>Reminder</b>\nCall the bank']);
	});

	it('drops a reminder a week late instead of sending it, linked or not', async () => {
		await start(createLinkCode('user-1'));
		mocks.sendMessage.mockClear();
		const remind = (text: string, dueAt: number, userId = 'user-1') =>
			addReminder({ userId, accountId: null, emailId: null, text, dueAt: new Date(dueAt).toISOString() });
		remind('Old news', Date.now() - 8 * 86_400_000);
		remind('Never linked', Date.now() - 8 * 86_400_000, 'user-2');
		remind('Fresh', Date.now() - 1000);
		await sendDueReminders();
		await sendDueReminders();
		expect(sentTexts()).toEqual(['<b>Reminder</b>\nFresh']);
		const settled = getDb().prepare(`SELECT COUNT(*) AS n FROM agent_reminders WHERE sent_at IS NOT NULL`).get() as { n: number };
		expect(settled.n).toBe(3);
	});

	it('sends at most twenty a run, and the rest next time', async () => {
		await start(createLinkCode('user-1'));
		mocks.sendMessage.mockClear();
		for (let i = 0; i < 25; i += 1) {
			addReminder({ userId: 'user-1', accountId: null, emailId: null, text: `r${i}`, dueAt: new Date(Date.now() - 60_000 + i).toISOString() });
		}
		await sendDueReminders();
		expect(mocks.sendMessage).toHaveBeenCalledTimes(20);
		await sendDueReminders();
		expect(mocks.sendMessage).toHaveBeenCalledTimes(25);
	});

	it('forgets sent reminders after a month', async () => {
		const id = addReminder({ userId: 'user-1', accountId: null, emailId: null, text: 'Gone', dueAt: new Date().toISOString() });
		getDb().prepare(`UPDATE agent_reminders SET sent_at = datetime('now', '-31 days') WHERE id = ?`).run(id);
		await sendDueReminders();
		expect(getDb().prepare('SELECT COUNT(*) AS n FROM agent_reminders WHERE id = ?').get(id)).toEqual({ n: 0 });
	});
});

// Last: it fills the hourly cap, which is kept in memory for the whole file.
describe('hourly cap', () => {
	it('holds urgent alerts past the cap instead of dropping them', async () => {
		await start(createLinkCode('user-1'));
		mocks.sendMessage.mockClear();
		// An hour clear of every send the earlier tests made.
		const later = Date.now() + 5 * 3_600_000;
		for (let i = 0; i < 21; i += 1) {
			queueAlert({ userId: 'user-1', accountId: 'acct-1', emailId: `cap-${i}`, html: `alert ${i}`, summary: '' }, later);
		}
		await flushAlerts(null, later);
		await flushAlerts(null, later + 1000);
		expect(mocks.sendMessage).toHaveBeenCalledTimes(20);
		// Sent once the hour frees up.
		await flushAlerts(null, later + 3_600_000 + 2000);
		expect(mocks.sendMessage).toHaveBeenCalledTimes(21);
		expect(sentTexts().at(-1)).toBe('alert 20');
	});
});
