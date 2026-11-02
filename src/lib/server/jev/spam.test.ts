import { describe, expect, it } from 'vitest';
import type { Email } from '$lib/jmap/types';
import {
	baseDomain,
	decideSpam,
	jevVerdict,
	parseAuthResults,
	parseSpamRules,
	securityFacts,
	summarizeSpam
} from './spam';

function email(overrides: Partial<Email> = {}): Email {
	return {
		id: 'e1',
		blobId: 'b',
		threadId: 't',
		mailboxIds: { inbox: true },
		from: [{ name: 'PayPal', email: 'service@paypal.com' }],
		to: [{ name: null, email: 'me@example.test' }],
		cc: null,
		subject: 'Hi',
		receivedAt: '2026-10-19T09:00:00Z',
		size: 1,
		preview: '',
		keywords: {},
		hasAttachment: false,
		...overrides
	};
}

describe('evidence', () => {
	it('reduces hosts to their registrable domain', () => {
		expect(baseDomain('mail.paypal.com')).toBe('paypal.com');
		expect(baseDomain('mail.shop.co.uk')).toBe('shop.co.uk');
		expect(baseDomain('paypal.com.')).toBe('paypal.com');
	});

	it('reads authentication from the topmost header only — our own server’s', () => {
		expect(
			parseAuthResults([
				'mx.example.test; spf=fail smtp.mailfrom=x; dkim=none; dmarc=FAIL header.from=paypal.com',
				'evil.example; spf=pass; dkim=pass; dmarc=pass'
			])
		).toEqual({ spf: 'fail', dkim: 'none', dmarc: 'fail' });
		expect(parseAuthResults(null)).toEqual({ spf: null, dkim: null, dmarc: null });
	});

	it('reads Stalwart’s rule names', () => {
		expect(parseSpamRules('BAYES_SPAM (5.1), DMARC_POLICY_REJECT; x, lower_case')).toEqual([
			'BAYES_SPAM',
			'DMARC_POLICY_REJECT'
		]);
	});

	it('spots a sender hiding behind another domain', () => {
		const facts = securityFacts(
			email({
				from: [{ name: 'PayPal.com Support', email: 'alerts@secure-pay.ru' }],
				replyTo: [{ name: null, email: 'help@other.example' }],
				htmlBody: [{ partId: '1', blobId: 'p', type: 'text/html', name: null }],
				bodyValues: {
					1: {
						value: '<a href="https://secure-pay.ru/x">a</a><a href="https://login.paypa1.co/y">b</a>',
						isEncodingProblem: false,
						isTruncated: false
					}
				},
				'header:authentication-results:asText:all': ['mx; spf=pass; dkim=none; dmarc=fail'],
				'header:x-spam-status:asText': 'Yes, score=7.2',
				'header:x-spam-score:asText': '7.2',
				'header:x-spam-result:asText': 'DMARC_POLICY_REJECT, BAYES_SPAM'
			})
		);
		expect(facts).toEqual({
			spf: 'pass',
			dkim: 'none',
			dmarc: 'fail',
			reply_to_differs: true,
			display_name_mismatch: true,
			link_domains: ['paypa1.co'],
			stalwart_spam_score: 7.2,
			stalwart_spam_rules: ['DMARC_POLICY_REJECT', 'BAYES_SPAM'],
			stalwart_flagged: true
		});
	});

	it('finds nothing odd about an ordinary email', () => {
		expect(securityFacts(email())).toMatchObject({
			reply_to_differs: false,
			display_name_mismatch: false,
			link_domains: [],
			stalwart_spam_score: null,
			stalwart_flagged: false
		});
	});
});

describe('decideSpam', () => {
	const base = { spam: 0.02, phishing: 0.01, inJunk: false, trusted: false, dmarcPassed: true };

	it('sends confident spam or phishing from strangers to Junk', () => {
		expect(decideSpam({ ...base, spam: 0.93 })).toBe('junk');
		expect(decideSpam({ ...base, phishing: 0.9 })).toBe('junk');
	});

	it('only warns about mail from contacts and people you’ve written to', () => {
		expect(decideSpam({ ...base, phishing: 0.97, trusted: true })).toBe('flag');
		expect(decideSpam({ ...base, spam: 0.4, trusted: true })).toBeNull();
	});

	it('only warns when it couldn’t check whether the sender is someone you know', () => {
		expect(decideSpam({ ...base, phishing: 0.97, trusted: null })).toBe('flag');
		expect(decideSpam({ ...base, spam: 0.95, trusted: null })).toBe('flag');
		expect(decideSpam({ ...base, spam: 0.4, trusted: null })).toBeNull();
	});

	it('warns in between, and leaves the rest alone', () => {
		expect(decideSpam({ ...base, spam: 0.6 })).toBe('flag');
		expect(decideSpam({ ...base, phishing: 0.89 })).toBe('flag');
		expect(decideSpam({ ...base, spam: 0.59 })).toBeNull();
	});

	it('rescues from Junk only when very sure and DMARC passed', () => {
		expect(decideSpam({ ...base, inJunk: true })).toBe('rescue');
		expect(decideSpam({ ...base, inJunk: true, spam: 0.1 })).toBeNull();
		expect(decideSpam({ ...base, inJunk: true, phishing: 0.05 })).toBeNull();
	});

	it('leaves Junk alone when DMARC failed, never ran, or errored', () => {
		// A spoofed sender passes no DMARC at all, so "didn't fail" is not enough.
		expect(decideSpam({ ...base, inJunk: true, dmarcPassed: false })).toBeNull();
	});

	it('does not need DMARC to move mail into Junk or warn about it', () => {
		expect(decideSpam({ ...base, spam: 0.95, dmarcPassed: false })).toBe('junk');
		expect(decideSpam({ ...base, spam: 0.7, dmarcPassed: false })).toBe('flag');
	});
});

describe('the watch-only report', () => {
	const row = (id: string, spam: number, phishing: number, stalwartSpam: boolean, correctedTo: 'spam' | 'ham' | null = null) => ({
		emailId: id,
		spam,
		phishing,
		stalwartSpam,
		action: null,
		correctedTo
	});

	it('calls Jev sure only at the thresholds it would act on', () => {
		expect(jevVerdict({ spam: 0.95, phishing: 0 })).toBe('spam');
		expect(jevVerdict({ spam: 0.05, phishing: 0.01 })).toBe('clean');
		expect(jevVerdict({ spam: 0.5, phishing: 0.01 })).toBe('unsure');
	});

	it('counts agreement and lists both kinds of disagreement', () => {
		const summary = summarizeSpam([
			row('a', 0.95, 0.1, true), // agree: spam
			row('b', 0.02, 0.01, false), // agree: clean
			row('c', 0.95, 0.1, false, 'spam'), // Jev stricter; you sided with Jev
			row('d', 0.02, 0.01, true, 'spam'), // Jev looser; you overruled Jev
			row('e', 0.5, 0.2, true) // unsure
		]);
		expect(summary).toEqual({
			judged: 5,
			agree: 2,
			unsure: 1,
			jevStricter: ['c'],
			jevLooser: ['d'],
			youAgreedWithJev: 1,
			youOverruledJev: 1
		});
	});
});
