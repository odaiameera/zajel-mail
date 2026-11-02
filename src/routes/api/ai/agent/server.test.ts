import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'ameera-agent-route-')), 'test.db');

const mocks = vi.hoisted(() => ({ runAgentTurn: vi.fn() }));
vi.mock('$lib/server/ai/claude', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/ai/claude')>()),
	claudeConfigured: () => true
}));
vi.mock('$lib/server/agent/runtime', () => ({ runAgentTurn: mocks.runAgentTurn }));

import { runMigrations } from '$lib/server/db/migrate';
import { listMessages } from '$lib/server/db/queries/ai-conversations';
import { turnRunning } from '$lib/server/agent/turns';
import type { AgentTurnResult } from '$lib/server/agent/runtime';
import { POST } from './+server';

const EMAIL = 'me@example.test';
const auth = { authHeader: `Basic ${Buffer.from(`${EMAIL}:pw`).toString('base64')}`, accountId: 'jmap' };

function ask(message: string) {
	return POST({
		request: new Request('http://localhost/api/ai/agent', {
			method: 'POST',
			body: JSON.stringify({ action: 'chat', message, timeZone: 'Asia/Amman' })
		}),
		locals: { auth, user: { id: 'user-1' }, activeAccountId: 'acct-1' }
	} as unknown as Parameters<typeof POST>[0]);
}

const result = (overrides: Partial<AgentTurnResult>): AgentTurnResult => ({
	outcome: 'answered',
	message: 'Done.',
	done: [],
	pending: [],
	...overrides
});

beforeAll(() => {
	runMigrations();
});

beforeEach(() => {
	vi.clearAllMocks();
});

describe('POST /api/ai/agent', () => {
	it('names the session in a header before the reply, and keeps the turn', async () => {
		mocks.runAgentTurn.mockResolvedValue(result({ message: 'Marked it read.' }));
		const response = await ask('Mark the newsletter read');
		const id = response.headers.get('X-Conversation-Id');
		expect(id).toBeTruthy();
		const body = JSON.parse(await response.text());
		expect(body).toMatchObject({ message: 'Marked it read.', conversationId: id });
		expect(listMessages(id!, EMAIL).map((m) => [m.role, m.content])).toEqual([
			['user', 'Mark the newsletter read'],
			['assistant', 'Marked it read.']
		]);
	});

	it('marks the session busy while the turn runs', async () => {
		let finish!: (value: AgentTurnResult) => void;
		mocks.runAgentTurn.mockReturnValue(new Promise((resolve) => (finish = resolve)));
		const response = await ask('Tidy my inbox');
		const id = response.headers.get('X-Conversation-Id')!;
		expect(turnRunning(id)).toBe(true);
		finish(result({}));
		await response.text();
		expect(turnRunning(id)).toBe(false);
	});

	it('keeps a refusal out of the transcript', async () => {
		mocks.runAgentTurn.mockResolvedValue(result({ outcome: 'refused', message: 'I can’t help with that request.' }));
		const response = await ask('Is this phishing?');
		const body = JSON.parse(await response.text());
		expect(body.message).toBe('I can’t help with that request.');
		expect(listMessages(response.headers.get('X-Conversation-Id')!, EMAIL)).toEqual([]);
	});

	it('keeps a turn that stopped part way, with its cards', async () => {
		mocks.runAgentTurn.mockResolvedValue(
			result({
				outcome: 'stopped',
				message: 'The AI service is rate limiting this account. So far: Archived 2 messages. One change waits for your confirmation.',
				done: ['Archived 2 messages'],
				pending: [
					{
						id: 'action-1',
						userId: 'user-1',
						accountId: 'acct-1',
						conversationId: null,
						kind: 'send_email',
						payload: { to: ['dana@example.test'], cc: [], subject: 'Re: Lunch?', text: 'Thursday works.' },
						status: 'pending',
						result: null,
						createdAt: '',
						expiresAt: ''
					}
				]
			})
		);
		const response = await ask('Archive the receipts and tell Dana Thursday works');
		const body = JSON.parse(await response.text());
		expect(body.done).toEqual(['Archived 2 messages']);
		expect(body.pending).toEqual([expect.objectContaining({ id: 'action-1', label: 'Send email' })]);
		expect(listMessages(body.conversationId, EMAIL)).toHaveLength(2);
	});
});
