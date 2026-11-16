import { describe, expect, it } from 'vitest';
import { composeFromMailto, parseMailto } from './mailto';

describe('parseMailto', () => {
	it('reads an address on its own, with or without the scheme', () => {
		expect(parseMailto('mailto:support@example.com').to).toEqual(['support@example.com']);
		expect(parseMailto('MAILTO:support@example.com').to).toEqual(['support@example.com']);
		expect(parseMailto('support@example.com').to).toEqual(['support@example.com']);
	});

	it('reads every field a link may set', () => {
		expect(
			parseMailto(
				'mailto:a@example.com,b@example.com?cc=c@example.com&BCC=d@example.com&subject=Hello%20there&body=Line%201%0D%0ALine%202'
			)
		).toEqual({
			to: ['a@example.com', 'b@example.com'],
			cc: ['c@example.com'],
			bcc: ['d@example.com'],
			subject: 'Hello there',
			body: 'Line 1\nLine 2'
		});
	});

	it('adds a to= field to the addresses before the question mark', () => {
		expect(parseMailto('mailto:a@example.com?to=b@example.com%2Cc@example.com').to).toEqual([
			'a@example.com',
			'b@example.com',
			'c@example.com'
		]);
		expect(parseMailto('mailto:?to=a@example.com,b@example.com').to).toEqual(['a@example.com', 'b@example.com']);
	});

	it('keeps a plus as a plus', () => {
		const m = parseMailto('mailto:me+news@example.com?subject=C++&cc=you+x@example.com');
		expect(m.to).toEqual(['me+news@example.com']);
		expect(m.cc).toEqual(['you+x@example.com']);
		expect(m.subject).toBe('C++');
	});

	it('decodes text outside ASCII, and survives a stray percent sign', () => {
		expect(parseMailto('mailto:a@example.com?subject=%D9%85%D8%B1%D8%AD%D8%A8%D8%A7').subject).toBe('مرحبا');
		expect(parseMailto('mailto:a@example.com?subject=100%').subject).toBe('100%');
	});

	it('ignores headers a link has no business setting', () => {
		const m = parseMailto('mailto:a@example.com?from=boss@example.com&attach=/etc/passwd&subject=Hi&x');
		expect(m).toEqual({ to: ['a@example.com'], cc: [], bcc: [], subject: 'Hi', body: '' });
	});

	it('keeps the subject on one line and the first one given', () => {
		expect(parseMailto('mailto:a@example.com?subject=One%0D%0ABcc:%20x@example.com&subject=Two').subject).toBe(
			'One Bcc: x@example.com'
		);
	});

	it('is empty for an empty link', () => {
		expect(parseMailto('')).toEqual({ to: [], cc: [], bcc: [], subject: '', body: '' });
		expect(parseMailto('mailto:')).toEqual({ to: [], cc: [], bcc: [], subject: '', body: '' });
	});
});

describe('composeFromMailto', () => {
	it('gives the composer comma-joined recipients and an HTML body', () => {
		expect(
			composeFromMailto('mailto:a@example.com,b@example.com?cc=c@example.com&subject=Hi&body=One%0ATwo%0A%0AThree')
		).toEqual({
			to: 'a@example.com, b@example.com',
			cc: 'c@example.com',
			bcc: '',
			subject: 'Hi',
			body: '<div>One</div><div>Two</div><div><br></div><div>Three</div>'
		});
	});

	it("never lets a link's body in as markup", () => {
		expect(composeFromMailto('mailto:a@example.com?body=%3Cimg%20src=x%20onerror=alert(1)%3E').body).toBe(
			'<div>&lt;img src=x onerror=alert(1)&gt;</div>'
		);
	});

	it('leaves the body empty when the link has none', () => {
		expect(composeFromMailto('mailto:a@example.com').body).toBe('');
	});
});
