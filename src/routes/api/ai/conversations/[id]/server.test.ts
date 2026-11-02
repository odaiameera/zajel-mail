import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'ameera-conv-route-')), 'test.db');

import { getDb } from '$lib/server/db/index';
import { runMigrations } from '$lib/server/db/migrate';
import { appendMessage, createConversation } from '$lib/server/db/queries/ai-conversations';
import { createPendingAction } from '$lib/server/agent/store';
import { trackTurn } from '$lib/server/agent/turns';
import { GET } from './+server';

const USER = 'user-1';
const EMAIL = 'me@example.test';
const auth = { authHeader: `Basic ${Buffer.from(`${EMAIL}:pw`).toString('base64')}` };

async function get(id: string, user: { id: string } | null = { id: USER }) {
	const response = await GET({ locals: { auth, user: user ?? undefined }, params: { id } } as unknown as Parameters<typeof GET>[0]);
	return { status: response.status, body: await response.json() };
}

beforeAll(() => {
	runMigrations();
	getDb().prepare(`INSERT INTO app_user (id, email, password_hash) VALUES (?, 'u@example.test', 'x')`).run(USER);
	getDb()
		.prepare(
			`INSERT INTO mail_accounts (id, user_id, email, server_url, jmap_account_id, secret_enc)
			 VALUES ('acct-1', ?, ?, 'https://mail.example', 'jmap', 'x')`
		)
		.run(USER, EMAIL);
});

beforeEach(() => {
	getDb().exec('DELETE FROM ai_conversations; DELETE FROM agent_actions;');
});

describe('GET /api/ai/conversations/[id]', () => {
	it('replays the session with the cards still waiting in it', async () => {
		const id = createConversation(EMAIL);
		appendMessage(id, EMAIL, 'user', 'Tell Dana Thursday works');
		appendMessage(id, EMAIL, 'assistant', 'The reply is waiting for you.');
		const action = createPendingAction({
			userId: USER,
			accountId: 'acct-1',
			conversationId: id,
			kind: 'send_email',
			payload: { to: ['dana@example.test'], cc: [], subject: 'Re: Lunch?', text: 'Thursday works.' }
		});
		createPendingAction({ userId: USER, accountId: 'acct-1', conversationId: 'another', kind: 'send_email', payload: {} });

		const { status, body } = await get(id);
		expect(status).toBe(200);
		expect(body.messages.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant']);
		expect(body.pending).toEqual([
			expect.objectContaining({ id: action.id, label: 'Send email', title: 'Re: Lunch?', lines: ['To dana@example.test'], confirmLabel: 'Send' })
		]);
		expect(body.running).toBe(false);
	});

	it('says while a turn is still running in the session', async () => {
		const id = createConversation(EMAIL);
		let finish!: () => void;
		const turn = trackTurn(id, new Promise<void>((resolve) => (finish = resolve)));
		expect((await get(id)).body.running).toBe(true);
		finish();
		await turn;
		expect((await get(id)).body.running).toBe(false);
	});

	it('shows nothing of a session that is not yours', async () => {
		const id = createConversation('someone@example.test');
		expect((await get(id)).status).toBe(404);
	});
});
