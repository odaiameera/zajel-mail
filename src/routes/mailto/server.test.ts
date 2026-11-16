import { describe, expect, it } from 'vitest';
import { GET } from './+server';

type Event = Parameters<typeof GET>[0];

function open(link: string | null): Response | { status: number; location: string } {
	const url = new URL('http://localhost/mailto');
	if (link !== null) url.searchParams.set('to', link);
	try {
		return GET({ url } as Event) as Response;
	} catch (thrown) {
		return thrown as { status: number; location: string };
	}
}

function linkAt(target: string): string | null {
	return new URL(target, 'http://localhost').searchParams.get('mailto');
}

describe('/mailto', () => {
	it('passes the link on to the inbox as it came', () => {
		const link = 'mailto:a+b@example.com?subject=Hello%20there&body=One%0ATwo&cc=c@example.com';
		const res = open(link) as { status: number; location: string };
		expect(res.status).toBe(303);
		expect(res.location.startsWith('/inbox?mailto=')).toBe(true);
		expect(linkAt(res.location)).toBe(link);
	});

	it('still asks for a new message when the link is empty or missing', () => {
		expect(open('mailto:')).toMatchObject({ status: 303, location: '/inbox?mailto=mailto%3A' });
		expect(open(null)).toMatchObject({ status: 303, location: '/inbox?mailto=' });
	});

	it('sends a long link on in a page, not in a response header', async () => {
		const link = `mailto:a@example.com?body=${'word%20'.repeat(600)}&subject="><script>`;
		const res = open(link) as Response;
		expect(res.status).toBe(200);
		expect(res.headers.get('location')).toBeNull();
		expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
		const html = await res.text();
		expect(html).not.toContain('<script>');
		const target = /content="0;url=([^"]*)"/.exec(html)?.[1].replace(/&amp;/g, '&') ?? '';
		expect(linkAt(target)).toBe(link);
	});
});
