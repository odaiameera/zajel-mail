import { beforeEach, describe, expect, it, vi } from 'vitest';

// A small mail server and a small scheduled_sends table, both in memory.
const state = vi.hoisted(() => ({
	mailboxes: [] as { id: string; name: string; role: string | null; parentId: string | null }[],
	inScheduled: true,
	/** What EmailSubmission/set answers, or throws. */
	submission: { created: { sub1: { id: 'S1' } } } as Record<string, unknown>,
	submitThrows: null as Error | null,
	mailboxGetThrows: null as Error | null,
	moveThrows: null as Error | null,
	failed: [] as [string, string][],
	removed: [] as string[],
	retried: [] as [string, string, string][],
	rows: {} as Record<string, Row | undefined>,
	cancelled: [] as string[]
}));

type Row = import('./db/queries/scheduled-sends').ScheduledSendRow;

vi.mock('$lib/jmap/auth', () => ({
	createClient: () => ({
		request: async ([[name]]: [string, Record<string, unknown>][]) => {
			if (name === 'Mailbox/get') {
				if (state.mailboxGetThrows) throw state.mailboxGetThrows;
				return { methodResponses: [['Mailbox/get', { list: state.mailboxes }, '0']], sessionState: '' };
			}
			if (name === 'Email/get') {
				const list = state.inScheduled ? [{ id: 'M1', mailboxIds: { SCHED: true } }] : [];
				return { methodResponses: [['Email/get', { list }, '0']], sessionState: '' };
			}
			if (name === 'EmailSubmission/set') {
				if (state.submitThrows) throw state.submitThrows;
				return { methodResponses: [['EmailSubmission/set', state.submission, '0']], sessionState: '' };
			}
			if (name === 'Email/set') {
				if (state.moveThrows) throw state.moveThrows;
				return { methodResponses: [['Email/set', { updated: { M1: null } }, '0']], sessionState: '' };
			}
			throw new Error(`unexpected ${name}`);
		}
	})
}));
vi.mock('./auth/accounts', () => ({
	getAccount: () => ({ id: 'acct', needs_reauth: 0 }),
	authStateForAccount: () => ({ authHeader: 'Basic x', accountId: 'jmap', apiUrl: 'https://mail.example/jmap/', sessionState: '' }),
	markNeedsReauth: vi.fn()
}));
vi.mock('./db/queries/scheduled-sends', () => ({
	failScheduledSend: (id: string, error: string) => state.failed.push([id, error]),
	removeScheduledSend: (id: string) => state.removed.push(id),
	retryScheduledSendLater: (id: string, at: string, error: string) => state.retried.push([id, at, error]),
	// Like the statement: only a pending or failed row can be cancelled.
	cancelScheduledSendRow: (_acct: string, emailId: string) => {
		const row = state.rows[emailId];
		if (!row || row.status === 'sending') return null;
		delete state.rows[emailId];
		state.cancelled.push(emailId);
		return row;
	},
	getScheduledSend: (_acct: string, emailId: string) => state.rows[emailId] ?? null,
	claimDueSends: () => [],
	insertScheduledSend: vi.fn(),
	recoverInterruptedSends: vi.fn(),
	retryScheduledSendNow: vi.fn()
}));

import { JMAPMethodError } from '$lib/jmap/client';
import type { AuthState } from '$lib/jmap/types';
import { cancelScheduledSend, deliverScheduledSend } from './scheduled-send';

const FOLDERS = [
	{ id: 'IN', name: 'Inbox', role: 'inbox', parentId: null },
	{ id: 'SENT', name: 'Sent', role: 'sent', parentId: null },
	{ id: 'DRAFTS', name: 'Drafts', role: 'drafts', parentId: null },
	{ id: 'SCHED', name: 'Scheduled', role: null, parentId: null }
];

const row = (attempts = 1): Row => ({
	id: 'row-1',
	mail_account_id: 'acct',
	jmap_email_id: 'M1',
	identity_id: 'I1',
	envelope: JSON.stringify({ mailFrom: { email: 'me@example.test' }, rcptTo: [{ email: 'you@example.test' }] }),
	send_at: '2026-10-20T07:00:00.000Z',
	status: 'sending',
	attempts,
	last_error: null,
	created_at: '2026-10-20T06:59:00.000Z'
});

const auth = { accountId: 'jmap' } as AuthState;

beforeEach(() => {
	state.mailboxes = FOLDERS;
	state.inScheduled = true;
	state.submission = { created: { sub1: { id: 'S1' } } };
	state.submitThrows = null;
	state.mailboxGetThrows = null;
	state.moveThrows = null;
	state.failed = [];
	state.removed = [];
	state.retried = [];
	state.rows = { M1: { ...row(), status: 'pending' } };
	state.cancelled = [];
	vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('delivering a scheduled send', () => {
	it('sends the message and drops the row', async () => {
		await deliverScheduledSend(row());
		expect(state.removed).toEqual(['row-1']);
		expect(state.failed).toEqual([]);
	});

	it('records a missing Scheduled folder on the row instead of forgetting the message', async () => {
		state.mailboxes = FOLDERS.filter((m) => m.id !== 'SCHED');
		await deliverScheduledSend(row());
		expect(state.removed).toEqual([]);
		expect(state.failed).toEqual([['row-1', expect.stringContaining('Scheduled folder')]]);
	});

	it('tries again later when the server refuses for now, and gives up once the ladder is used up', async () => {
		state.submission = { notCreated: { sub1: { type: 'rateLimit', description: 'Slow down' } } };
		await deliverScheduledSend(row(1));
		expect(state.failed).toEqual([]);
		expect(state.retried).toEqual([['row-1', expect.any(String), 'Slow down']]);
		expect(Date.parse(state.retried[0][1]) - Date.now()).toBeGreaterThan(50_000);

		await deliverScheduledSend(row(5));
		expect(state.failed).toEqual([['row-1', 'Slow down']]);
	});

	it('retries a passing method error and fails a final one', async () => {
		state.submitThrows = new JMAPMethodError('serverUnavailable', 'Restarting');
		await deliverScheduledSend(row(1));
		expect(state.retried).toEqual([['row-1', expect.any(String), expect.stringContaining('Restarting')]]);
		expect(state.failed).toEqual([]);

		state.submitThrows = new JMAPMethodError('invalidProperties', 'No such identity');
		await deliverScheduledSend(row(1));
		expect(state.failed).toEqual([['row-1', 'No such identity']]);
	});

	it('fails a refusal the server would repeat', async () => {
		state.submission = { notCreated: { sub1: { type: 'forbiddenFrom', description: 'Not your address' } } };
		await deliverScheduledSend(row(1));
		expect(state.retried).toEqual([]);
		expect(state.failed).toEqual([['row-1', 'Not your address']]);
	});
});

describe('cancelling a scheduled send', () => {
	it('moves the message to Drafts and drops the row', async () => {
		expect(await cancelScheduledSend('acct', auth, 'M1')).toEqual({ success: true, draftId: 'M1' });
		expect(state.cancelled).toEqual(['M1']);
	});

	it('leaves the row in place when the server cannot be reached, so the send still happens', async () => {
		state.mailboxGetThrows = new Error('ECONNREFUSED');
		const result = await cancelScheduledSend('acct', auth, 'M1');
		expect(result).toMatchObject({ success: false, code: 'unreachable' });
		expect(state.cancelled).toEqual([]);
		expect(state.rows.M1).toBeDefined();
	});

	it('reports a failed move as "not sent", not as an unknown error', async () => {
		state.moveThrows = new Error('socket hang up');
		const result = await cancelScheduledSend('acct', auth, 'M1');
		expect(result).toMatchObject({ success: false, code: 'move-failed' });
		expect(state.cancelled).toEqual(['M1']);
	});

	it('says when the message is already on its way', async () => {
		state.rows = { M1: { ...row(), status: 'sending' } };
		const result = await cancelScheduledSend('acct', auth, 'M1');
		expect(result).toMatchObject({ success: false, code: 'sending' });
		expect(state.cancelled).toEqual([]);
	});
});
