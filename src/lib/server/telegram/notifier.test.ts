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
	moveEmails: vi.fn(),
	scheduleReminder: vi.fn()
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
vi.mock('$lib/jmap/email', () => ({ updateEmailMailboxes: mocks.updateEmailMailboxes, moveEmails: mocks.moveEmails }));
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
vi.mock('$lib/server/db/queries/reminders', () => ({ scheduleReminder: mocks.scheduleReminder }));

import { getDb } from '../db/index';
import { runMigrations } from '../db/migrate';
import { addReminder, createButton, createLinkCode, getLink, setLinkFlags } from './store';
import { handleUpdate, notifyUrgent, sendDueReminders } from './notifier';

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
	getDb().exec('DELETE FROM telegram_links; DELETE FROM telegram_link_codes; DELETE FROM telegram_buttons; DELETE FROM agent_reminders;');
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
		expect(mocks.moveEmails).not.toHaveBeenCalled();

		await handleUpdate({ update_id: 4, message: { message_id: 3, chat: { id: CHAT, type: 'private' }, text: '/stop' } });
		expect(getLink('user-1')?.paused).toBe(true);
	});
});

describe('buttons', () => {
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
		expect(mocks.moveEmails).toHaveBeenCalledWith({}, 'jmap', ['e2'], 'RML', 'IN', expect.any(Set));
		const at = Date.parse(mocks.scheduleReminder.mock.calls[0][4]);
		expect(at - Date.now()).toBeGreaterThan(59 * 60_000);
	});
});

describe('urgent alerts', () => {
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

describe('reminders', () => {
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
});
