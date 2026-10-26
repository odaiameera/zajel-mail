import { describe, expect, it } from 'vitest';
import type { JMAPClient } from '$lib/jmap/client';
import type { Email, JMAPSession, MethodCall } from '$lib/jmap/types';
import { gatherFacts, headerFacts } from './facts';

function email(overrides: Partial<Email> = {}): Email {
	return {
		id: 'e1',
		blobId: 'b1',
		threadId: 't1',
		mailboxIds: { inbox: true },
		from: [{ name: 'Sam', email: 'Sam@Example.com' }],
		to: [{ name: null, email: 'me@example.test' }],
		cc: null,
		subject: 'Hello',
		receivedAt: '2026-10-18T09:00:00Z',
		size: 100,
		preview: '',
		keywords: {},
		hasAttachment: false,
		...overrides
	};
}

describe('headerFacts', () => {
	it('reads list headers, bulk markers and no-reply senders', () => {
		const facts = headerFacts(
			email({
				from: [{ name: 'Shop', email: 'no-reply@shop.example' }],
				to: [{ name: null, email: 'list@shop.example' }],
				cc: [{ name: null, email: 'me@example.test' }],
				'header:list-unsubscribe': ' <https://shop.example/u>',
				'header:list-id:asText': ' deals.shop.example ',
				'header:precedence:asText': 'Bulk',
				'header:auto-submitted:asText': 'auto-generated'
			}),
			'Me@Example.test'
		);
		expect(facts).toEqual({
			addressed_to_you_directly: false,
			has_list_unsubscribe: true,
			list_id: 'deals.shop.example',
			bulk_precedence: true,
			auto_submitted: true,
			sender_looks_automated: true,
			contains_sign_in_code: false
		});
	});

	it('treats a personal email as personal', () => {
		expect(headerFacts(email({ 'header:auto-submitted:asText': 'no' }), 'me@example.test')).toMatchObject({
			addressed_to_you_directly: true,
			has_list_unsubscribe: false,
			auto_submitted: false,
			sender_looks_automated: false
		});
	});

	it('spots a sign-in code', () => {
		const e = email({ subject: '504072 is your verification code' });
		expect(headerFacts(e, 'me@example.test').contains_sign_in_code).toBe(true);
	});
});

describe('gatherFacts', () => {
	/** Sent holds mail to sam@example.com in thread t1; contacts holds Sam. */
	function fakeClient(opts: { failSent?: boolean } = {}) {
		const calls: MethodCall[][] = [];
		const client = {
			async request(methodCalls: MethodCall[]) {
				calls.push(methodCalls);
				const responses = methodCalls.map(([name, args, tag]) => {
					switch (name) {
						case 'Email/query': {
							if (opts.failSent) throw new Error('boom');
							const to = (args.filter as { to: string }).to;
							return [name, { total: to === 'sam@example.com' ? 2 : 0 }, tag];
						}
						case 'Thread/get':
							return [name, { list: [{ id: 't1', emailIds: ['e1', 's1'] }] }, tag];
						case 'Email/get':
							return [
								name,
								{
									list: [
										{ id: 'e1', threadId: 't1', mailboxIds: { inbox: true } },
										{ id: 's1', threadId: 't1', mailboxIds: { sent: true } }
									]
								},
								tag
							];
						case 'ContactCard/query':
							return [name, { ids: ['c1'] }, tag];
						case 'ContactCard/get':
							return [
								name,
								{ list: [{ id: 'c1', emails: { e: { address: 'sam@example.com' } } }] },
								tag
							];
						default:
							return [name, {}, tag];
					}
				});
				return { methodResponses: responses, sessionState: '' };
			}
		} as unknown as JMAPClient;
		return { client, calls };
	}

	const session = {
		capabilities: { 'urn:ietf:params:jmap:contacts': {} },
		primaryAccounts: { 'urn:ietf:params:jmap:contacts': 'acc' },
		accounts: { acc: { accountCapabilities: { 'urn:ietf:params:jmap:contacts': {} } } }
	} as unknown as JMAPSession;

	const emails = [
		email(),
		email({ id: 'e2', threadId: 't2', from: [{ name: 'News', email: 'news@paper.example' }] })
	];

	it('asks the server what it knows about each sender and thread', async () => {
		const { client } = fakeClient();
		const facts = await gatherFacts(client, 'acc', emails, {
			accountEmail: 'me@example.test',
			sentId: 'sent',
			session
		});
		expect(facts.get('e1')).toMatchObject({
			sender_in_contacts: true,
			you_have_written_to_sender: true,
			you_have_written_in_this_thread: true
		});
		expect(facts.get('e2')).toMatchObject({
			sender_in_contacts: false,
			you_have_written_to_sender: false,
			you_have_written_in_this_thread: false
		});
	});

	it('says "couldn’t tell" instead of failing when a lookup does', async () => {
		const { client } = fakeClient({ failSent: true });
		const facts = await gatherFacts(client, 'acc', emails, {
			accountEmail: 'me@example.test',
			sentId: 'sent',
			session: null
		});
		expect(facts.get('e1')).toMatchObject({
			sender_in_contacts: null,
			you_have_written_to_sender: null,
			you_have_written_in_this_thread: true,
			addressed_to_you_directly: true
		});
	});
});
