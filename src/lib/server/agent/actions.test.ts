import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'ameera-actions-')), 'test.db');

const mocks = vi.hoisted(() => ({ sendComposed: vi.fn() }));
vi.mock('./compose', () => ({ sendComposed: mocks.sendComposed }));
vi.mock('$lib/server/auth/accounts', () => ({
	getAccount: (id: string) => ({ id, user_id: id === 'acct-other' ? 'someone-else' : 'user-1', email: 'me@example.test' }),
	authStateForAccount: (account: { id: string }) => ({ accountId: `jmap-${account.id}` })
}));

import { getDb } from '../db/index';
import { runMigrations } from '../db/migrate';
import { createPendingAction, getPendingAction, listAudit } from './store';
import { decidePendingAction } from './actions';

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
