import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ safeFetch: vi.fn(), resolveTxt: vi.fn() }));
vi.mock('./net', () => ({ safeFetch: mocks.safeFetch }));
vi.mock('node:dns/promises', () => ({ resolveTxt: mocks.resolveTxt }));

import type { SafeFetchOptions } from './net';
import { isFreemailDomain, resolveBimi, resolveFavicon, resolveGravatar } from './resolve';

/** Just enough PNG for the header reader: signature, then IHDR with the given size. */
function png(width: number, height: number): Buffer {
	const b = Buffer.alloc(33);
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
	b.writeUInt32BE(13, 8);
	b.write('IHDR', 12, 'ascii');
	b.writeUInt32BE(width, 16);
	b.writeUInt32BE(height, 20);
	return b;
}

type Answer = { status: number; bytes?: Buffer; contentType?: string } | 'unreachable' | 'blocked';

/** Script safeFetch by URL: an HTTP answer, or a failure it reports. */
function script(answers: Record<string, Answer>, fallback: Answer = { status: 404 }) {
	mocks.safeFetch.mockImplementation(async (url: string, opts: SafeFetchOptions & { allowEmpty?: boolean } = {}) => {
		const answer = answers[url] ?? fallback;
		if (answer === 'unreachable' || answer === 'blocked') {
			opts.onFailure?.(answer);
			return null;
		}
		const bytes = answer.bytes ?? Buffer.alloc(0);
		if (bytes.length === 0 && !opts.allowEmpty) {
			opts.onFailure?.('empty');
			return null;
		}
		return { status: answer.status, bytes, contentType: answer.contentType ?? null };
	});
}

beforeEach(() => {
	mocks.resolveTxt.mockRejectedValue(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }));
});

afterEach(() => {
	mocks.safeFetch.mockReset();
	mocks.resolveTxt.mockReset();
	vi.unstubAllGlobals();
});

describe('isFreemailDomain', () => {
	it('knows the shared providers under any suffix', () => {
		for (const d of ['gmail.com', 'GMAIL.com', 'hotmail.fr', 'yahoo.co.uk', 'outlook.de', 'live.nl', 'icloud.com', 'proton.me', 'gmx.at']) {
			expect(isFreemailDomain(d)).toBe(true);
		}
	});

	it('leaves companies alone, even ones whose names start the same way', () => {
		for (const d of ['example.com', 'mail.example.co.uk', 'live.example.com', 'gmailtools.io']) {
			expect(isFreemailDomain(d)).toBe(false);
		}
	});
});

describe('resolveFavicon', () => {
	it('passes over a raster that declares a wall-sized canvas, however it is ranked', async () => {
		// A 250 KB PNG can say it is 40000x40000; drawing it would allocate gigabytes.
		script({
			'https://evil.test/apple-touch-icon.png': { status: 200, bytes: png(40000, 40000) },
			'https://evil.test/favicon.ico': { status: 200, bytes: png(64, 64) }
		});
		const lookup = await resolveFavicon('evil.test');
		expect(lookup.outcome).toBe('found');
		if (lookup.outcome === 'found') expect(lookup.asset.bytes).toEqual(png(64, 64));
	});

	it('still prefers the biggest icon that is actually an icon', async () => {
		script({
			'https://brand.test/favicon.ico': { status: 200, bytes: png(16, 16) },
			'https://brand.test/apple-touch-icon.png': { status: 200, bytes: png(180, 180) }
		});
		const lookup = await resolveFavicon('brand.test');
		expect(lookup.outcome).toBe('found');
		if (lookup.outcome === 'found') expect(lookup.asset.bytes).toEqual(png(180, 180));
	});

	it('tells a site with no icon from a site it could not reach', async () => {
		script({});
		expect((await resolveFavicon('plain.test')).outcome).toBe('none');

		script({}, 'unreachable');
		expect((await resolveFavicon('down.test')).outcome).toBe('unreachable');

		// The homepage answered, but every icon timed out: not a verdict either.
		script({ 'https://half.test/': { status: 200, bytes: Buffer.from('<html></html>'), contentType: 'text/html' } }, 'unreachable');
		expect((await resolveFavicon('half.test')).outcome).toBe('unreachable');

		// A server that errors is failing, not declining.
		script({}, { status: 503, bytes: Buffer.from('busy') });
		expect((await resolveFavicon('busy.test')).outcome).toBe('unreachable');

		// A name with no address, or one we refuse to connect to, is an answer.
		script({}, 'blocked');
		expect((await resolveFavicon('internal.test')).outcome).toBe('none');
	});

	it('does not spend a fetch on an inline data: icon', async () => {
		script({
			'https://spa.test/': {
				status: 200,
				contentType: 'text/html',
				bytes: Buffer.from('<html><head><link rel="icon" href="data:image/svg+xml,<svg xmlns=\'http://www.w3.org/2000/svg\'/>"></head></html>')
			},
			'https://spa.test/favicon.ico': { status: 200, bytes: png(32, 32) }
		});
		expect((await resolveFavicon('spa.test')).outcome).toBe('found');
		const urls = mocks.safeFetch.mock.calls.map((c) => c[0] as string);
		expect(urls.some((u) => u.startsWith('data:'))).toBe(false);
	});
});

describe('resolveGravatar', () => {
	const url = (email: string) =>
		mocks.safeFetch.mock.calls.find((c) => (c[0] as string).includes('gravatar.com') && email)?.[0] as string;

	it('takes the 404 for "no avatar" as the answer it is', async () => {
		script({}, { status: 404 });
		expect((await resolveGravatar('nobody@example.test')).outcome).toBe('none');
		expect(url('nobody@example.test')).toContain('d=404');
	});

	it('keeps an outage apart from a missing avatar', async () => {
		script({}, 'unreachable');
		expect((await resolveGravatar('a@example.test')).outcome).toBe('unreachable');
		script({}, { status: 502, bytes: Buffer.from('bad gateway') });
		expect((await resolveGravatar('a@example.test')).outcome).toBe('unreachable');
	});

	it('serves a real avatar and refuses an oversized one', async () => {
		script({}, { status: 200, bytes: png(256, 256) });
		const found = await resolveGravatar('a@example.test');
		expect(found.outcome).toBe('found');
		if (found.outcome === 'found') expect(found.asset.source).toBe('gravatar');

		script({}, { status: 200, bytes: png(8000, 8000) });
		expect((await resolveGravatar('a@example.test')).outcome).toBe('none');
	});
});

describe('resolveBimi', () => {
	it('is none without a record, unreachable when nobody could answer', async () => {
		expect((await resolveBimi('plain.test')).outcome).toBe('none');

		mocks.resolveTxt.mockRejectedValue(Object.assign(new Error('ETIMEOUT'), { code: 'ETIMEOUT' }));
		vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); })); // DoH down too
		expect((await resolveBimi('plain.test')).outcome).toBe('unreachable');
	});

	it('is unreachable when the logo itself cannot be fetched', async () => {
		mocks.resolveTxt.mockResolvedValue([['v=BIMI1; l=https://brand.test/logo.svg']]);
		script({}, 'unreachable');
		expect((await resolveBimi('brand.test')).outcome).toBe('unreachable');

		script({ 'https://brand.test/logo.svg': { status: 200, bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>') } });
		const found = await resolveBimi('brand.test');
		expect(found.outcome).toBe('found');
		if (found.outcome === 'found') expect(found.asset.source).toBe('bimi');
	});
});
