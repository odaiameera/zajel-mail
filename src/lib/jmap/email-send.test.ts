import { describe, expect, it, vi } from 'vitest';
import { EmailUpdateError, buildEnvelope, destroyEmail, saveDraft, sendEmail, submitStoredEmail } from './email';
import type { JMAPClient } from './client';
import type { ComposeEmail } from './types';

const compose: ComposeEmail = {
	from: { name: 'Odai', email: 'odai@example.test' },
	to: [{ name: null, email: 'dana@example.test' }],
	cc: [],
	bcc: [{ name: null, email: 'secret@example.test' }],
	subject: 'Hello',
	body: '<p>Hi <b>Dana</b></p>',
	inReplyTo: 'orig@mail.example.test',
	references: 'root@mail.example.test orig@mail.example.test',
	importance: 'high'
};

function clientReturning(methodResponses: unknown[]) {
	const request = vi.fn().mockResolvedValue({ methodResponses, sessionState: 's' });
	return { client: { request } as unknown as JMAPClient, request };
}

describe('sendEmail', () => {
	it('creates the message as a draft, submits it, and moves it to Sent only on success', async () => {
		const { client, request } = clientReturning([
			['Email/set', { created: { draft1: { id: 'M1' } } }, '0'],
			['EmailSubmission/set', { created: { sub1: { id: 'S1' } } }, '1'],
			['Email/set', { updated: { M1: null } }, '1']
		]);

		const result = await sendEmail(client, 'acct', compose, { drafts: 'D', sent: 'S' }, { id: 'I1', email: 'odai@example.test' }, { replaceDraftId: 'OLD' });

		expect(result).toEqual({ success: true });
		const [calls] = request.mock.calls[0];
		const [emailSet, submissionSet] = calls;

		expect(emailSet[0]).toBe('Email/set');
		const created = emailSet[1].create.draft1;
		expect(created.mailboxIds).toEqual({ D: true });
		expect(created.keywords).toEqual({ $draft: true, $seen: true });
		// The draft being sent goes in a request of its own, after the create.
		expect(emailSet[1].destroy).toBeUndefined();
		expect(request.mock.calls[1][0]).toEqual([['Email/set', { accountId: 'acct', destroy: ['OLD'] }, '0']]);
		// multipart/alternative: an HTML part and its plain-text rendering
		expect(created.htmlBody).toEqual([{ partId: 'body', type: 'text/html' }]);
		expect(created.textBody).toEqual([{ partId: 'text', type: 'text/plain' }]);
		expect(created.bodyValues.text.value).toBe('Hi Dana');
		// threading by Message-ID, and importance headers
		expect(created.inReplyTo).toEqual(['orig@mail.example.test']);
		expect(created.references).toEqual(['root@mail.example.test', 'orig@mail.example.test']);
		expect(created['header:Importance:asText']).toBe('high');
		expect(created['header:X-Priority:asText']).toBe('1 (Highest)');

		expect(submissionSet[0]).toBe('EmailSubmission/set');
		expect(submissionSet[1].create.sub1).toEqual({
			emailId: '#draft1',
			identityId: 'I1',
			envelope: {
				mailFrom: { email: 'odai@example.test' },
				rcptTo: [{ email: 'dana@example.test' }, { email: 'secret@example.test' }]
			}
		});
		expect(submissionSet[1].onSuccessUpdateEmail).toEqual({
			'#sub1': { mailboxIds: { S: true }, keywords: { $seen: true } }
		});
	});

	it('keeps the message as a draft and returns its id when the submission is rejected', async () => {
		const { client } = clientReturning([
			['Email/set', { created: { draft1: { id: 'M1' } } }, '0'],
			['EmailSubmission/set', { notCreated: { sub1: { type: 'forbiddenToSend', description: 'Quota' } } }, '1']
		]);
		const result = await sendEmail(client, 'acct', compose, { drafts: 'D', sent: 'S' }, { id: 'I1', email: 'odai@example.test' });
		expect(result).toEqual({ success: false, error: 'Quota', draftId: 'M1' });
	});

	it('reports a message the server would not create', async () => {
		const { client } = clientReturning([
			['Email/set', { notCreated: { draft1: { type: 'invalidProperties', description: 'bad to' } } }, '0'],
			['EmailSubmission/set', { notCreated: { sub1: { type: 'invalidProperties' } } }, '1']
		]);
		const result = await sendEmail(client, 'acct', compose, { drafts: 'D', sent: 'S' }, { id: 'I1', email: 'odai@example.test' });
		expect(result).toEqual({ success: false, error: 'bad to' });
	});

	it('keeps the draft being sent when the server refuses the new copy', async () => {
		// Over quota: the server would still have run a destroy sent in the
		// same Email/set, and the only copy of the message would be gone.
		const { client, request } = clientReturning([
			['Email/set', { notCreated: { draft1: { type: 'overQuota', description: 'Quota exceeded' } } }, '0'],
			['EmailSubmission/set', { notCreated: { sub1: { type: 'invalidProperties' } } }, '1']
		]);
		const result = await sendEmail(client, 'acct', compose, { drafts: 'D', sent: 'S' }, { id: 'I1', email: 'odai@example.test' }, { replaceDraftId: 'OLD' });
		expect(result).toEqual({ success: false, error: 'Quota exceeded' });
		expect(request).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(request.mock.calls)).not.toContain('destroy');
	});

	it('drops the old draft when the new copy exists but the submission is refused', async () => {
		const { client, request } = clientReturning([
			['Email/set', { created: { draft1: { id: 'M1' } } }, '0'],
			['EmailSubmission/set', { notCreated: { sub1: { type: 'forbiddenToSend', description: 'Quota' } } }, '1']
		]);
		const result = await sendEmail(client, 'acct', compose, { drafts: 'D', sent: 'S' }, { id: 'I1', email: 'odai@example.test' }, { replaceDraftId: 'OLD' });
		expect(result).toEqual({ success: false, error: 'Quota', draftId: 'M1' });
		expect(request.mock.calls[1][0]).toEqual([['Email/set', { accountId: 'acct', destroy: ['OLD'] }, '0']]);
	});

	it('sets no importance headers for normal importance', async () => {
		const { client, request } = clientReturning([
			['Email/set', { created: { draft1: { id: 'M1' } } }, '0'],
			['EmailSubmission/set', { created: { sub1: { id: 'S1' } } }, '1']
		]);
		await sendEmail(client, 'acct', { ...compose, importance: 'normal' }, { drafts: 'D', sent: 'S' }, { id: 'I1', email: 'odai@example.test' });
		const created = request.mock.calls[0][0][0][1].create.draft1;
		expect(created['header:Importance:asText']).toBeUndefined();
		expect(request.mock.calls[0][0][0][1].destroy).toBeUndefined();
	});
});

describe('saveDraft', () => {
	it('replaces the previous version of the draft once the new one exists', async () => {
		const { client, request } = clientReturning([['Email/set', { created: { draft1: { id: 'M2' } } }, '0']]);
		const result = await saveDraft(client, 'acct', 'D', compose, 'M1');
		expect(result).toEqual({ success: true, id: 'M2' });
		const args = request.mock.calls[0][0][0][1];
		expect(args.destroy).toBeUndefined();
		expect(args.create.draft1.mailboxIds).toEqual({ D: true });
		expect(request.mock.calls[1][0]).toEqual([['Email/set', { accountId: 'acct', destroy: ['M1'] }, '0']]);
	});

	it('keeps the previous version when the server refuses the new one', async () => {
		const { client, request } = clientReturning([
			['Email/set', { notCreated: { draft1: { type: 'overQuota', description: 'Quota exceeded' } } }, '0']
		]);
		const result = await saveDraft(client, 'acct', 'D', compose, 'M1');
		expect(result).toEqual({ success: false, error: 'Quota exceeded' });
		expect(request).toHaveBeenCalledTimes(1);
	});

	it('still reports the save when only the old version could not be removed', async () => {
		const request = vi
			.fn()
			.mockResolvedValueOnce({ methodResponses: [['Email/set', { created: { draft1: { id: 'M2' } } }, '0']] })
			.mockRejectedValueOnce(new Error('network down'));
		const client = { request } as unknown as JMAPClient;
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		expect(await saveDraft(client, 'acct', 'D', compose, 'M1')).toEqual({ success: true, id: 'M2' });
		expect(warn).toHaveBeenCalledOnce();
		warn.mockRestore();
	});

	it('creates a first draft without destroying anything', async () => {
		const { client, request } = clientReturning([['Email/set', { created: { draft1: { id: 'M1' } } }, '0']]);
		await saveDraft(client, 'acct', 'D', compose);
		expect(request).toHaveBeenCalledTimes(1);
		expect(request.mock.calls[0][0][0][1].destroy).toBeUndefined();
	});
});

describe('destroyEmail', () => {
	it('throws when the server refuses, and treats an already-deleted message as done', async () => {
		const refused = clientReturning([['Email/set', { notDestroyed: { M1: { type: 'forbidden', description: 'No' } } }, '0']]);
		await expect(destroyEmail(refused.client, 'acct', 'M1')).rejects.toBeInstanceOf(EmailUpdateError);
		const gone = clientReturning([['Email/set', { notDestroyed: { M1: { type: 'notFound' } } }, '0']]);
		await expect(destroyEmail(gone.client, 'acct', 'M1')).resolves.toBeUndefined();
	});
});

describe('buildEnvelope', () => {
	it('includes Bcc and lists each address once', () => {
		expect(
			buildEnvelope(
				{
					to: [{ name: null, email: 'dana@example.test' }],
					cc: [{ name: 'Dana', email: 'Dana@Example.test' }],
					bcc: [{ name: null, email: 'secret@example.test' }]
				},
				'me@example.test'
			)
		).toEqual({
			mailFrom: { email: 'me@example.test' },
			rcptTo: [{ email: 'dana@example.test' }, { email: 'secret@example.test' }]
		});
	});
});

describe('scheduled messages', () => {
	it('carry their send time as the Date header', async () => {
		const { client, request } = clientReturning([['Email/set', { created: { draft1: { id: 'M1' } } }, '0']]);
		await saveDraft(client, 'acct', 'SCHED', { ...compose, sentAt: '2026-10-20T07:00:00Z' });
		const created = request.mock.calls[0][0][0][1].create.draft1;
		expect(created.sentAt).toBe('2026-10-20T07:00:00Z');
		expect(created.mailboxIds).toEqual({ SCHED: true });
	});

	const envelope = { mailFrom: { email: 'me@example.test' }, rcptTo: [{ email: 'dana@example.test' }] };
	const boxes = { scheduled: 'SCHED', sent: 'SENT' };

	it('are submitted as stored and moved to Sent', async () => {
		const request = vi
			.fn()
			.mockResolvedValueOnce({ methodResponses: [['Email/get', { list: [{ id: 'M1', mailboxIds: { SCHED: true } }] }, '0']] })
			.mockResolvedValueOnce({ methodResponses: [['EmailSubmission/set', { created: { sub1: { id: 'S1' } } }, '0']] });
		const client = { request } as unknown as JMAPClient;

		expect(await submitStoredEmail(client, 'acct', 'M1', 'I1', envelope, boxes)).toEqual({ status: 'sent' });
		const [[submission]] = request.mock.calls[1];
		expect(submission[1].create.sub1).toEqual({ emailId: 'M1', identityId: 'I1', envelope });
		expect(submission[1].onSuccessUpdateEmail).toEqual({
			'#sub1': { mailboxIds: { SENT: true }, keywords: { $seen: true } }
		});
	});

	it('aren’t sent once they have left Scheduled', async () => {
		for (const list of [[], [{ id: 'M1', mailboxIds: { DRAFTS: true } }]]) {
			const request = vi.fn().mockResolvedValueOnce({ methodResponses: [['Email/get', { list }, '0']] });
			const client = { request } as unknown as JMAPClient;
			expect(await submitStoredEmail(client, 'acct', 'M1', 'I1', envelope, boxes)).toEqual({ status: 'gone' });
			expect(request).toHaveBeenCalledTimes(1);
		}
	});

	it('report why the server refused them', async () => {
		const request = vi
			.fn()
			.mockResolvedValueOnce({ methodResponses: [['Email/get', { list: [{ id: 'M1', mailboxIds: { SCHED: true } }] }, '0']] })
			.mockResolvedValueOnce({
				methodResponses: [['EmailSubmission/set', { notCreated: { sub1: { type: 'forbiddenToSend', description: 'Quota exceeded' } } }, '0']]
			});
		const client = { request } as unknown as JMAPClient;
		expect(await submitStoredEmail(client, 'acct', 'M1', 'I1', envelope, boxes)).toEqual({
			status: 'failed',
			type: 'forbiddenToSend',
			error: 'Quota exceeded'
		});
	});
});
