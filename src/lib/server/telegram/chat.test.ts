import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'zajel-telegram-chat-')), 'test.db');

const mocks = vi.hoisted(() => ({
	sendMessage: vi.fn(async () => ({ message_id: 100 })),
	sendTyping: vi.fn(async () => ({})),
	answerCallback: vi.fn(async () => ({})),
	clearButtons: vi.fn(async () => ({})),
	runAgentTurn: vi.fn(),
	decidePendingAction: vi.fn(),
	sendSavedDraft: vi.fn(),
	cancelScheduledSend: vi.fn(),
	claude: true
}));
vi.mock('$env/dynamic/private', () => ({ env: { ORIGIN: 'https://mail.example.test' } }));
vi.mock('./bot', async (importOriginal) => ({
	...(await importOriginal<typeof import('./bot')>()),
	telegramConfigured: () => true,
	sendMessage: mocks.sendMessage,
	sendTyping: mocks.sendTyping,
	answerCallback: mocks.answerCallback,
	clearButtons: mocks.clearButtons
}));
vi.mock('$lib/server/ai/claude', () => ({ claudeConfigured: () => mocks.claude }));
vi.mock('$lib/server/agent/runtime', () => ({ runAgentTurn: mocks.runAgentTurn }));
vi.mock('$lib/server/agent/compose', () => ({ sendSavedDraft: mocks.sendSavedDraft }));
vi.mock('$lib/server/scheduled-send', () => ({ cancelScheduledSend: mocks.cancelScheduledSend }));
vi.mock('$lib/server/agent/actions', () => ({
	STEP_UP_KINDS: new Set(['create_job']),
	decidePendingAction: mocks.decidePendingAction,
	pendingView: (action: { id: string; kind: string; payload: Record<string, unknown> }) => ({
		id: action.id,
		kind: action.kind,
		label: 'Send email',
		title: String(action.payload.subject ?? ''),
		lines: [`To ${(action.payload.to as string[]).join(', ')}`],
		body: String(action.payload.text ?? ''),
		confirmLabel: 'Send',
		danger: false
	})
}));
vi.mock('$lib/server/auth/accounts', () => ({
	getAccount: (id: string) => ({ id, user_id: id === 'acct-other' ? 'someone-else' : 'user-1', email: `${id}@example.test`, needs_reauth: 0 }),
	listAccounts: () => [{ id: 'acct-1', user_id: 'user-1', email: 'acct-1@example.test', needs_reauth: 0 }],
	authStateForAccount: (account: { id: string }) => ({ accountId: `jmap-${account.id}` })
}));

import { getDb } from '../db/index';
import { runMigrations } from '../db/migrate';
import { createPendingAction } from '../agent/store';
import { listMessages } from '../db/queries/ai-conversations';
import { createAgentButton, createLinkCode, getLink, linkChatWithCode, setConfirmInChat } from './store';
import { chatInTelegram, pressAgentButton, resetChatState, sendCard } from './chat';
import { flushAlerts, handleUpdate, queueUrgent } from './notifier';

const CHAT = 555;
const link = () => getLink('user-1')!;
type Sent = [string, string, { text: string; callback_data?: string; url?: string }[][], number | undefined];
const sent = () => mocks.sendMessage.mock.calls as unknown as Sent[];
const texts = () => sent().map((c) => c[1]);
const turnResult = (over: Record<string, unknown> = {}) => ({
	outcome: 'answered',
	message: 'You have **two** unread.',
	done: [],
	pending: [],
	drafts: [],
	...over
});

beforeAll(() => {
	runMigrations();
	const db = getDb();
	db.prepare(`INSERT INTO app_user (id, email, password_hash) VALUES ('user-1', 'u@example.test', 'x')`).run();
	for (const id of ['acct-1', 'acct-2']) {
		db.prepare(
			`INSERT INTO mail_accounts (id, user_id, email, server_url, jmap_account_id, secret_enc)
			 VALUES (?, 'user-1', ?, 'https://mail.example', 'jmap', 'x')`
		).run(id, `${id}@example.test`);
	}
});

beforeEach(() => {
	vi.clearAllMocks();
	resetChatState();
	mocks.claude = true;
	getDb().exec('DELETE FROM telegram_links; DELETE FROM telegram_agent_buttons; DELETE FROM agent_actions; DELETE FROM ai_messages; DELETE FROM ai_conversations; DELETE FROM telegram_outbox;');
	linkChatWithCode(createLinkCode('user-1', Date.now(), 'Asia/Amman'), String(CHAT), 'me');
	mocks.runAgentTurn.mockResolvedValue(turnResult());
});

describe('a message typed in the chat', () => {
	it('is an agent turn, on the linking browser’s clock, in the chat’s own conversation', async () => {
		await chatInTelegram(link(), 'Anything urgent?', { replyTo: 7 });
		const turn = mocks.runAgentTurn.mock.calls[0][0];
		expect(turn).toMatchObject({ source: 'telegram', message: 'Anything urgent?', timeZone: 'Asia/Amman', accountRowId: 'acct-1', userEmail: 'acct-1@example.test' });
		expect(turn.note).toContain('with a button to confirm it');
		expect(sent()[0]).toEqual([String(CHAT), 'You have <b>two</b> unread.', [], 7]);
		// Kept, and shown in the web panel as "Telegram".
		const conversation = link().conversationId!;
		expect(listMessages(conversation, 'acct-1@example.test').map((m) => m.content)).toEqual(['Anything urgent?', 'You have **two** unread.']);
		expect(getDb().prepare('SELECT title FROM ai_conversations WHERE id = ?').get(conversation)).toEqual({ title: 'Telegram' });
		// The next message carries on in it.
		await chatInTelegram(link(), 'And tomorrow?');
		expect(mocks.runAgentTurn.mock.calls[1][0]).toMatchObject({ conversationId: conversation, history: [{ role: 'user', content: 'Anything urgent?' }, { role: 'assistant', content: 'You have **two** unread.' }] });
	});

	it('takes one message at a time', async () => {
		let finish!: (v: unknown) => void;
		mocks.runAgentTurn.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
		const first = chatInTelegram(link(), 'Summarise today');
		await vi.waitFor(() => expect(mocks.runAgentTurn).toHaveBeenCalledTimes(1));
		await chatInTelegram(link(), 'And archive it all');
		expect(texts()).toEqual(['I’m still working on your last message. Send this again once I’ve answered.']);
		finish(turnResult());
		await first;
		expect(mocks.runAgentTurn).toHaveBeenCalledTimes(1);
	});

	it('says so when the agent isn’t on Claude', async () => {
		mocks.claude = false;
		await chatInTelegram(link(), 'Hi');
		expect(mocks.runAgentTurn).not.toHaveBeenCalled();
		expect(texts()[0]).toContain('needs Claude');
	});

	it('shows what changed, then each card with Send and Cancel, then each draft with Send and Edit', async () => {
		const action = createPendingAction({ userId: 'user-1', accountId: 'acct-1', conversationId: null, kind: 'send_email', payload: { to: ['dana@example.test'], subject: 'Re: Lunch?', text: 'Thursday works.' } });
		mocks.runAgentTurn.mockResolvedValueOnce(
			turnResult({
				message: 'Done.',
				done: ['Archived 3 messages'],
				pending: [action],
				drafts: [{ id: 'd1', to: ['sam@example.test'], subject: 'Re: Q3', text: 'Here they are.', replyToEmailId: 'e9' }]
			})
		);
		await chatInTelegram(link(), 'Tidy and reply');
		const [answer, card, draft] = sent();
		expect(answer[1]).toBe('Done.\n\n• Archived 3 messages');
		expect(card[1]).toBe('<b>Send email</b> · Re: Lunch?\nTo dana@example.test\n\nThursday works.');
		expect(card[2][0].map((b) => b.text)).toEqual(['Send', 'Cancel']);
		expect(draft[1]).toBe('<b>Draft reply</b> · Re: Q3\nTo sam@example.test\n\nHere they are.');
		expect(draft[2]).toEqual([[{ text: 'Send', callback_data: expect.any(String) }, { text: 'Edit in Zajel', url: 'https://mail.example.test/email/d1' }]]);
	});

	it('sends cards to the web app when confirming here is off', async () => {
		setConfirmInChat('user-1', false);
		const action = createPendingAction({ userId: 'user-1', accountId: 'acct-1', conversationId: null, kind: 'send_email', payload: { to: ['dana@example.test'], subject: 'Hi', text: 'x' } });
		await sendCard(link(), action);
		expect(sent()[0][1]).toContain('Confirm it in Zajel');
		expect(sent()[0][2]).toEqual([[{ text: 'Open Zajel', url: 'https://mail.example.test/' }]]);
	});

	it('reaches the agent from the linked private chat only, and /new starts over', async () => {
		const message = (text: string, chatId = CHAT, type = 'private') =>
			handleUpdate({ update_id: 3, message: { message_id: 8, chat: { id: chatId, type }, text } });
		await message('Hello', 999);
		await message('Hello', CHAT, 'group');
		expect(mocks.runAgentTurn).not.toHaveBeenCalled();
		await message('Hello');
		await vi.waitFor(() => expect(mocks.runAgentTurn).toHaveBeenCalledTimes(1));
		await vi.waitFor(() => expect(texts()).toContain('You have <b>two</b> unread.'));
		const before = link().conversationId;
		await message('/new');
		expect(link().conversationId).not.toBe(before);
		await message('/whatever');
		expect(texts().at(-1)).toContain('/new starts a new conversation');
	});
});

describe('Zajel’s buttons in the chat', () => {
	const button = (kind: 'confirm' | 'cancel' | 'undo_send' | 'send_draft' | 'draft_reply', ref: string, accountId = 'acct-1') =>
		createAgentButton({ userId: 'user-1', accountId, kind, ref });

	it('confirms a card from Telegram, and offers Undo while the send is held', async () => {
		mocks.decidePendingAction.mockResolvedValueOnce({
			status: 200,
			message: 'Sending to dana@example.test in 10 seconds',
			scheduled: { emailId: 'held-1', sendAt: '2030-01-01T00:00:10Z', undo: true }
		});
		await pressAgentButton(link(), 'q1', button('confirm', 'act-1'), 42);
		expect(mocks.decidePendingAction).toHaveBeenCalledWith('user-1', 'act-1', 'confirm', 'telegram');
		expect(mocks.clearButtons).toHaveBeenCalledWith(String(CHAT), 42);
		expect(sent()[0][1]).toBe('Sending to dana@example.test in 10 seconds');
		expect(sent()[0][2][0][0].text).toBe('Undo');
		expect(sent()[0][3]).toBe(42);
	});

	it('works once: a second press of the same button has expired', async () => {
		mocks.decidePendingAction.mockResolvedValue({ status: 200, message: 'Cancelled' });
		const id = button('cancel', 'act-1');
		await pressAgentButton(link(), 'q1', id);
		await pressAgentButton(link(), 'q2', id);
		expect(mocks.decidePendingAction).toHaveBeenCalledTimes(1);
		expect(mocks.answerCallback).toHaveBeenLastCalledWith('q2', 'This button has expired');
		expect(texts()).toEqual(['Cancelled. Nothing was changed.']);
	});

	it('won’t confirm from the chat once that is switched off, and the button keeps', async () => {
		const id = button('confirm', 'act-1');
		setConfirmInChat('user-1', false);
		await pressAgentButton(link(), 'q1', id);
		expect(mocks.decidePendingAction).not.toHaveBeenCalled();
		expect(mocks.answerCallback).toHaveBeenCalledWith('q1', 'Confirming from Telegram is off. Confirm it in Zajel.');
		setConfirmInChat('user-1', true);
		mocks.decidePendingAction.mockResolvedValueOnce({ status: 200, message: 'Sent to dana@example.test' });
		await pressAgentButton(link(), 'q2', id);
		expect(mocks.decidePendingAction).toHaveBeenCalledTimes(1);
	});

	it('sends a draft as it is now, held for Undo send', async () => {
		mocks.sendSavedDraft.mockResolvedValueOnce({ success: true, to: ['sam@example.test'], scheduled: { emailId: 'held-2', sendAt: 'x' } });
		await pressAgentButton(link(), 'q1', button('send_draft', 'd1', 'acct-2'), 5);
		expect(mocks.sendSavedDraft).toHaveBeenCalledWith({ accountId: 'jmap-acct-2' }, 'acct-2', 'acct-2@example.test', 'd1', 10);
		expect(sent()[0][1]).toBe('Sending to sam@example.test in 10 seconds.');
		expect(sent()[0][2][0][0].text).toBe('Undo');
	});

	it('keeps the Send button when sending fails', async () => {
		mocks.sendSavedDraft.mockResolvedValueOnce({ success: false, error: 'That draft is gone: it was sent or deleted' });
		const id = button('send_draft', 'd1');
		await pressAgentButton(link(), 'q1', id);
		expect(texts()).toEqual(['That draft is gone: it was sent or deleted']);
		mocks.sendSavedDraft.mockResolvedValueOnce({ success: true, to: ['sam@example.test'], scheduled: null });
		await pressAgentButton(link(), 'q2', id);
		expect(texts()[1]).toBe('Sent to sam@example.test.');
	});

	it('takes a held send back to Drafts', async () => {
		mocks.cancelScheduledSend.mockResolvedValueOnce({ success: true, draftId: 'held-1' });
		await pressAgentButton(link(), 'q1', button('undo_send', 'held-1'));
		expect(mocks.cancelScheduledSend).toHaveBeenCalledWith('acct-1', { accountId: 'jmap-acct-1' }, 'held-1');
		expect(sent()[0][1]).toBe('Not sent. It’s back in your Drafts.');
		expect(sent()[0][2]).toEqual([[{ text: 'Edit in Zajel', url: 'https://mail.example.test/email/held-1' }]]);
	});

	it('drafts a reply to an alert’s email, in the account the alert came from', async () => {
		await pressAgentButton(link(), 'q1', button('draft_reply', 'e7', 'acct-2'), 11);
		expect(mocks.answerCallback).toHaveBeenCalledWith('q1', 'Drafting a reply…');
		const turn = mocks.runAgentTurn.mock.calls[0][0];
		expect(turn).toMatchObject({ accountRowId: 'acct-2', source: 'telegram' });
		expect(turn.message).toContain('Draft a reply to the email id=e7');
		// Its own conversation: the chat's stays the default account's.
		expect(link().conversationId).toBeNull();
	});

	it('ignores another login’s button', async () => {
		const id = createAgentButton({ userId: 'user-1', accountId: 'acct-1', kind: 'confirm', ref: 'act-1' });
		await pressAgentButton({ ...link(), userId: 'user-2' }, 'q1', id);
		expect(mocks.decidePendingAction).not.toHaveBeenCalled();
		expect(mocks.answerCallback).toHaveBeenCalledWith('q1', 'This button has expired');
	});
});

describe('urgent alerts', () => {
	it('carry Draft reply, which drafts in the alert’s account', async () => {
		const userId = queueUrgent('acct-2', { id: 'e7', subject: 'Contract today', from: [{ name: 'Dana', email: 'dana@example.test' }] });
		await flushAlerts(userId);
		const buttons = sent()[0][2];
		expect(buttons.map((row) => row.map((b) => b.text))).toEqual([['Mark read', 'Snooze 1h', 'Archive'], ['Draft reply', 'Open']]);
		mocks.sendMessage.mockClear();
		await handleUpdate({ update_id: 4, callback_query: { id: 'q1', data: buttons[1][0].callback_data, message: { message_id: 9, chat: { id: CHAT } } } });
		await vi.waitFor(() => expect(mocks.runAgentTurn).toHaveBeenCalledTimes(1));
		expect(mocks.runAgentTurn.mock.calls[0][0]).toMatchObject({ accountRowId: 'acct-2' });
		expect(mocks.runAgentTurn.mock.calls[0][0].message).toContain('id=e7');
	});
});
