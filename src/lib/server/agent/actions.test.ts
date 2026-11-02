import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'ameera-actions-')), 'test.db');

const mocks = vi.hoisted(() => ({ sendComposed: vi.fn(), saveComposedDraft: vi.fn() }));
vi.mock('./compose', () => ({ sendComposed: mocks.sendComposed, saveComposedDraft: mocks.saveComposedDraft }));
vi.mock('$lib/server/auth/accounts', () => ({
	getAccount: (id: string) => ({ id, user_id: id === 'acct-other' ? 'someone-else' : 'user-1', email: 'me@example.test' }),
	authStateForAccount: (account: { id: string }) => ({ accountId: `jmap-${account.id}` })
}));

import { getDb } from '../db/index';
import { runMigrations } from '../db/migrate';
import {
	createPendingAction,
	endTurnJournal,
	getPendingAction,
	listAudit,
	listPendingActions,
	noteTurnProgress,
	startTurnJournal,
	takeInterruptedTurns
} from './store';
import { decidePendingAction, pendingView } from './actions';

const USER = 'user-1';
const message = { to: ['dana@example.test'], cc: [], subject: 'Re: Lunch?', text: 'Thursday works.', inReplyTo: null, references: null, replyToEmailId: null };
const propose = (accountId = 'acct-1', payload: Record<string, unknown> = message) =>
	createPendingAction({ userId: USER, accountId, conversationId: null, kind: 'send_email', payload });

beforeAll(() => {
	runMigrations();
	const db = getDb();
	db.prepare(`INSERT INTO app_user (id, email, password_hash) VALUES (?, 'u@example.test', 'x')`).run(USER);
	for (const id of ['acct-1', 'acct-2', 'acct-other']) {
		db.prepare(
			`INSERT INTO mail_accounts (id, user_id, email, server_url, jmap_account_id, secret_enc)
			 VALUES (?, ?, ?, 'https://mail.example', 'jmap', 'x')`
		).run(id, USER, `${id}@example.test`);
	}
});

beforeEach(() => {
	vi.clearAllMocks();
	mocks.sendComposed.mockResolvedValue({ success: true });
	mocks.saveComposedDraft.mockResolvedValue({ success: true });
	getDb().prepare('DELETE FROM agent_actions').run();
	getDb().prepare('DELETE FROM agent_audit').run();
});

describe('deciding a pending action', () => {
	it('sends once on confirm, from the account it was written in', async () => {
		const action = propose('acct-2');
		expect(await decidePendingAction(USER, action.id, 'confirm')).toEqual({ status: 200, message: 'Sent to dana@example.test' });
		expect(mocks.sendComposed).toHaveBeenCalledTimes(1);
		expect(mocks.sendComposed.mock.calls[0][0]).toEqual({ accountId: 'jmap-acct-2' });
		expect(getPendingAction(USER, action.id)?.status).toBe('done');

		// A double click or a replay doesn't send it again.
		expect((await decidePendingAction(USER, action.id, 'confirm')).status).toBe(409);
		expect(mocks.sendComposed).toHaveBeenCalledTimes(1);
		expect(listAudit(USER)[0]).toMatchObject({ tool: 'send_email', tier: 'outward', outcome: 'done' });
	});

	it('sends nothing when cancelled, and then cannot be confirmed', async () => {
		const action = propose();
		expect((await decidePendingAction(USER, action.id, 'cancel')).status).toBe(200);
		expect((await decidePendingAction(USER, action.id, 'confirm')).status).toBe(409);
		expect(mocks.sendComposed).not.toHaveBeenCalled();
	});

	it('is invisible to another login', async () => {
		const action = propose();
		expect((await decidePendingAction('intruder', action.id, 'confirm')).status).toBe(404);
		expect(mocks.sendComposed).not.toHaveBeenCalled();
	});

	it('refuses an account that is not this login’s, or a payload that no longer checks out', async () => {
		expect((await decidePendingAction(USER, propose('acct-other').id, 'confirm')).status).toBe(502);
		expect((await decidePendingAction(USER, propose('acct-1', { ...message, to: ['not an address'] }).id, 'confirm')).status).toBe(502);
		expect(mocks.sendComposed).not.toHaveBeenCalled();
	});

	it('expires after a day', async () => {
		const action = propose();
		getDb().prepare(`UPDATE agent_actions SET expires_at = datetime('now', '-1 minute') WHERE id = ?`).run(action.id);
		expect(await decidePendingAction(USER, action.id, 'confirm')).toEqual({ status: 409, message: 'This has expired' });
		expect(mocks.sendComposed).not.toHaveBeenCalled();
	});
});

describe('the cards a chat session still has', () => {
	const proposeIn = (conversationId: string) =>
		createPendingAction({ userId: USER, accountId: 'acct-1', conversationId, kind: 'send_email', payload: message });

	it('lists what still waits for a click in that session, oldest first', async () => {
		const first = proposeIn('conv-1');
		const second = proposeIn('conv-1');
		proposeIn('conv-2');
		const decided = proposeIn('conv-1');
		await decidePendingAction(USER, decided.id, 'cancel');
		const stale = proposeIn('conv-1');
		getDb().prepare(`UPDATE agent_actions SET expires_at = datetime('now', '-1 minute') WHERE id = ?`).run(stale.id);

		expect(listPendingActions(USER, 'conv-1').map((a) => a.id)).toEqual([first.id, second.id]);
		expect(listPendingActions('intruder', 'conv-1')).toEqual([]);
	});
});

describe('a draft to someone else', () => {
	it('shows its text on the card and is saved once on confirm, in the account it was written in', async () => {
		const action = createPendingAction({ userId: USER, accountId: 'acct-2', conversationId: null, kind: 'save_draft', payload: message });
		expect(pendingView(action)).toMatchObject({
			label: 'Save draft',
			title: 'Re: Lunch?',
			lines: ['To dana@example.test'],
			body: 'Thursday works.',
			confirmLabel: 'Save draft'
		});
		expect(await decidePendingAction(USER, action.id, 'confirm')).toEqual({ status: 200, message: 'Saved a draft to dana@example.test' });
		expect(mocks.saveComposedDraft).toHaveBeenCalledWith({ accountId: 'jmap-acct-2' }, 'me@example.test', expect.objectContaining({ to: ['dana@example.test'] }));
		expect((await decidePendingAction(USER, action.id, 'confirm')).status).toBe(409);
		expect(mocks.saveComposedDraft).toHaveBeenCalledTimes(1);
	});
});

describe('a turn’s journal', () => {
	const open = (conversationId: string, text: string) =>
		startTurnJournal({ userId: USER, accountId: 'acct-1', conversationId, message: text });

	it('hands what an interrupted turn did to the next turn in that session, once, and is never a card', () => {
		const interrupted = open('conv-1', 'Tidy up');
		noteTurnProgress(interrupted, ['Archived 2 messages']);
		noteTurnProgress(interrupted, ['Archived 2 messages', 'Marked read 1 message']);
		// Nothing done before the process stopped: nothing to tell.
		open('conv-1', 'Hello');
		// Finished normally: its reply holds what it did.
		const finished = open('conv-1', 'Star it');
		noteTurnProgress(finished, ['Starred 1 message']);
		endTurnJournal(finished);
		// Another session's turn stays with that session.
		noteTurnProgress(open('conv-2', 'Elsewhere'), ['Snoozed “x” until 2026-11-03 09:00']);

		expect(listPendingActions(USER, 'conv-1')).toEqual([]);
		expect(takeInterruptedTurns('intruder', 'conv-1')).toEqual([]);
		expect(takeInterruptedTurns(USER, 'conv-1')).toEqual([{ message: 'Tidy up', done: ['Archived 2 messages', 'Marked read 1 message'] }]);
		expect(takeInterruptedTurns(USER, 'conv-1')).toEqual([]);
		expect(takeInterruptedTurns(USER, 'conv-2')).toHaveLength(1);
	});
});
