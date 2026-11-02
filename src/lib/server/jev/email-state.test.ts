import { describe, expect, it } from 'vitest';
import type { Email } from '$lib/jmap/types';
import { bodyExcerpt, buildEmailState, stripQuotedReplies, type JevFacts } from './email-state';

function email(overrides: Partial<Email> = {}): Email {
	return {
		id: 'e1',
		blobId: 'b1',
		threadId: 't1',
		mailboxIds: { inbox: true },
		from: [{ name: 'Sam Rivera', email: 'sam@example.com' }],
		to: [{ name: null, email: 'me@example.test' }],
		cc: null,
		subject: 'Lunch?',
		receivedAt: '2026-10-18T09:00:00Z',
		size: 100,
		preview: 'preview text',
		keywords: {},
		hasAttachment: false,
		...overrides
	};
}

const facts = { has_list_unsubscribe: false } as JevFacts;

describe('stripQuotedReplies', () => {
	it('keeps the new text and drops the quoted history', () => {
		const text = [
			'Friday works for me.',
			'',
			'On Thu, 16 Oct 2026 at 10:02, Sam Rivera <sam@example.com> wrote:',
			'> Can we move Thursday?',
			'> Something came up.'
		].join('\n');
		expect(stripQuotedReplies(text).trim()).toBe('Friday works for me.');
	});

	it('stops at a forwarded-message separator and skips stray quote lines', () => {
		const text = 'See below.\n> an earlier line\n---------- Forwarded Message ----------\nFrom: someone';
		expect(stripQuotedReplies(text).trim()).toBe('See below.');
	});
});

describe('bodyExcerpt', () => {
	it('uses the plain-text part when there is one, cut to the limit', () => {
		const e = email({
			textBody: [{ partId: '1', blobId: 'p1', type: 'text/plain', name: null }],
			bodyValues: { 1: { value: 'x'.repeat(5000), isEncodingProblem: false, isTruncated: false } }
		});
		expect(bodyExcerpt(e)).toHaveLength(2000);
		expect(bodyExcerpt(e, 10)).toBe('x'.repeat(10));
	});

	it('falls back to the HTML part as text', () => {
		const e = email({
			textBody: [],
			htmlBody: [{ partId: '2', blobId: 'p2', type: 'text/html', name: null }],
			bodyValues: {
				2: { value: '<p>Hello <b>there</b></p>', isEncodingProblem: false, isTruncated: false }
			}
		});
		expect(bodyExcerpt(e)).toBe('Hello there');
	});

	it('falls back to the preview when no body was fetched', () => {
		expect(bodyExcerpt(email())).toBe('preview text');
	});

	it('flattens an HTML-only message, whose html part is listed under textBody too', () => {
		const part = { partId: '2', blobId: 'p2', type: 'text/html', name: null };
		const e = email({
			textBody: [part],
			htmlBody: [part],
			bodyValues: {
				2: {
					value: '<!DOCTYPE html><html><head><style>.x{color:red}</style></head><body><p>Your order <b>shipped</b></p></body></html>',
					isEncodingProblem: false,
					isTruncated: false
				}
			}
		});
		expect(bodyExcerpt(e)).toBe('Your order shipped');
	});
});

describe('buildEmailState', () => {
	it('keeps the email and the facts in separate fields', () => {
		const state = buildEmailState(email({ cc: [{ name: 'Priya', email: 'priya@example.com' }] }), facts);
		expect(state).toEqual({
			email: {
				from: 'Sam Rivera <sam@example.com>',
				to: ['me@example.test'],
				cc: ['Priya <priya@example.com>'],
				subject: 'Lunch?',
				body_excerpt: 'preview text'
			},
			facts
		});
	});
});
