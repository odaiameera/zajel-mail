import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthState } from '$lib/jmap/types';

const mocks = vi.hoisted(() => ({
	sendEmail: vi.fn(async () => ({ success: true })),
	getMailboxes: vi.fn(async () => [
		{ id: 'box-drafts', role: 'drafts' },
		{ id: 'box-sent', role: 'sent' }
	]),
	resolveIdentity: vi.fn(() => ({ id: 'ident-1', email: 'me@example.test', name: 'Me' }))
}));
vi.mock('$lib/jmap/auth', () => ({ createClient: () => ({ fake: true }) }));
vi.mock('$lib/jmap/email', () => ({ sendEmail: mocks.sendEmail }));
vi.mock('$lib/jmap/mailbox', () => ({ getMailboxes: mocks.getMailboxes }));
vi.mock('$lib/server/identity-resolve', () => ({ resolveIdentity: mocks.resolveIdentity }));

import { sendItipReply } from './itip-reply';

const auth: AuthState = { authHeader: 'Basic xyz', accountId: 'acc', apiUrl: 'https://mail.example/jmap/', sessionState: '' };
const INVITE = [
	'BEGIN:VCALENDAR',
	'VERSION:2.0',
	'PRODID:-//Test//EN',
	'METHOD:REQUEST',
	'BEGIN:VEVENT',
	'UID:sync-1',
	'DTSTAMP:20261001T000000Z',
	'SEQUENCE:2',
	'DTSTART;TZID=Europe/Berlin:20261110T090000',
	'DTEND;TZID=Europe/Berlin:20261110T100000',
	'SUMMARY:Weekly sync',
	'ORGANIZER;CN=Boss:mailto:boss@example.test',
	'ATTENDEE;CN=Me;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:me@example.test',
	'ATTENDEE;PARTSTAT=ACCEPTED:mailto:other@example.test',
	'END:VEVENT',
	'END:VCALENDAR'
].join('\r\n');

const uploadMock = vi.fn(async () => new Response(JSON.stringify({ blobId: 'blob-1', size: 321 }), { status: 200 }));

beforeEach(() => vi.stubGlobal('fetch', uploadMock));
afterEach(() => {
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});

describe('sendItipReply', () => {
	it('uploads a METHOD:REPLY calendar and mails it to the organizer from the account', async () => {
		expect(await sendItipReply(auth, 'me@example.test', INVITE, 'ACCEPTED')).toBe('sent');

		const [url, init] = uploadMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe('https://mail.example/jmap/upload/acc/');
		expect((init.headers as Record<string, string>)['Content-Type']).toBe('text/calendar; method=REPLY; charset=utf-8');
		const ics = String(init.body);
		expect(ics).toContain('METHOD:REPLY');
		expect(ics).toContain('UID:sync-1');
		expect(ics).toContain('SEQUENCE:2');
		expect(ics.match(/^ATTENDEE/gm)).toHaveLength(1);
		expect(ics).toMatch(/ATTENDEE;[^\r\n]*PARTSTAT=ACCEPTED[^\r\n]*:mailto:me@example.test/);
		expect(ics).not.toContain('RSVP=TRUE');

		const [, accountId, compose, boxes, identity] = mocks.sendEmail.mock.calls[0] as unknown as [
			unknown,
			string,
			{ to: { email: string }[]; subject: string; attachments: { type: string; blobId: string }[] },
			{ drafts: string; sent: string },
			{ id: string }
		];
		expect(accountId).toBe('acc');
		expect(compose.to).toEqual([{ name: null, email: 'boss@example.test' }]);
		expect(compose.subject).toBe('Accepted: Weekly sync');
		expect(compose.attachments[0]).toMatchObject({ blobId: 'blob-1', type: 'text/calendar; method=REPLY; charset=utf-8' });
		expect(boxes).toEqual({ drafts: 'box-drafts', sent: 'box-sent' });
		expect(identity.id).toBe('ident-1');
	});

	it('has nobody to tell when the user is not an attendee, and reports a failed upload', async () => {
		expect(await sendItipReply(auth, 'stranger@example.test', INVITE, 'DECLINED')).toBe('none');
		expect(mocks.sendEmail).not.toHaveBeenCalled();

		uploadMock.mockResolvedValueOnce(new Response('no', { status: 500 }));
		expect(await sendItipReply(auth, 'me@example.test', INVITE, 'DECLINED')).toBe('failed');
		expect(mocks.sendEmail).not.toHaveBeenCalled();
	});
});
