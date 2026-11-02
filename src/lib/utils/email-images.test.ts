import { describe, expect, it } from 'vitest';
import type { EmailAttachment } from '$lib/jmap/types';
import {
	MAX_HTML_LENGTH,
	emailFrameCsp,
	prepareEmailForReading,
	proxiedImageUrl,
	rewriteEmailImages
} from './email-images';

const ctx = (attachments: Partial<EmailAttachment>[] = []) => ({
	emailId: 'M1',
	attachments: attachments as EmailAttachment[]
});

const proxied = (url: string) => proxiedImageUrl(url).replace(/&/g, '&amp;');

describe('rewriteEmailImages', () => {
	it('routes a remote image through the proxy, decoding entities in the URL', () => {
		const html = '<img src="https://media.licdn.com/dms/image/x?e=1&amp;v=beta" alt="Farah">';
		expect(rewriteEmailImages(html, ctx())).toBe(
			`<img src="${proxied('https://media.licdn.com/dms/image/x?e=1&v=beta')}" alt="Farah">`
		);
	});

	it('encodes the target so it is safe in every context', () => {
		expect(proxiedImageUrl("https://x.test/a b(1)'.png?a=1&b=2")).toBe(
			'/api/image-proxy?url=https%3A%2F%2Fx.test%2Fa%20b%281%29%27.png%3Fa%3D1%26b%3D2'
		);
	});

	it('handles unquoted, single-quoted, protocol-relative and http URLs', () => {
		const out = rewriteEmailImages(
			"<img src=https://a.test/1.png><img src='//b.test/2.png'><img src=\"http://c.test/3.png\">",
			ctx()
		);
		expect(out).toContain(`src="${proxied('https://a.test/1.png')}"`);
		expect(out).toContain(`src="${proxied('https://b.test/2.png')}"`);
		expect(out).toContain(`src="${proxied('http://c.test/3.png')}"`);
	});

	it('rewrites every srcset candidate and keeps the descriptors', () => {
		const out = rewriteEmailImages(
			'<picture><source srcset="https://a.test/1.png 1x, https://a.test/2.png 2x"><img src="https://a.test/1.png"></picture>',
			ctx()
		);
		expect(out).toContain(
			`srcset="${proxied('https://a.test/1.png')} 1x, ${proxied('https://a.test/2.png')} 2x"`
		);
	});

	it('rewrites background attributes and CSS backgrounds in style attributes', () => {
		const out = rewriteEmailImages(
			'<td background="https://a.test/bg.png" style="background-image:url(&quot;https://a.test/s.png&quot;);color:red">x</td>',
			ctx()
		);
		expect(out).toContain(`background="${proxied('https://a.test/bg.png')}"`);
		expect(out).toContain(
			`style="background-image:url(&quot;${proxiedImageUrl('https://a.test/s.png').replace(/&/g, '&amp;')}&quot;);color:red"`
		);
	});

	it('rewrites images in <style> but leaves fonts and imported stylesheets alone', () => {
		const css =
			"@import url('https://fonts.googleapis.com/css?family=Inter');" +
			"@font-face{font-family:X;src:url(https://fonts.test/x.woff2)}" +
			".hero{background:url('https://a.test/hero.jpg')}";
		const out = rewriteEmailImages(`<style>${css}</style>`, ctx());
		expect(out).toContain("@import url('https://fonts.googleapis.com/css?family=Inter');");
		expect(out).toContain('src:url(https://fonts.test/x.woff2)');
		expect(out).toContain(`.hero{background:url("${proxiedImageUrl('https://a.test/hero.jpg')}")}`);
	});

	it('resolves cid: images to the inline part', () => {
		const out = rewriteEmailImages('<img src="cid:logo@example.com"><img src="cid:missing">', ctx([
			{ cid: 'logo@example.com', blobId: 'B9', name: 'logo.png', type: 'image/png', disposition: 'inline' }
		]));
		expect(out).toContain('src="/api/email/M1/attachment/B9?name=logo.png&amp;disposition=inline"');
		expect(out).toContain('src="cid:missing"');
	});

	it('leaves data: URLs, links and lookalike attributes untouched', () => {
		const html =
			'<img src="data:image/png;base64,AAAA"><img alt="x" data-src="https://a.test/x.png">' +
			'<a href="https://a.test/page">link</a>';
		expect(rewriteEmailImages(html, ctx())).toBe(html);
	});

	it('neutralises relative images with no <base>, which would hit this server', () => {
		// The reading view renders on this origin, so `/api/...` is a request to
		// the webmail itself, cookies and all — and `/api/image-proxy?url=` would
		// smuggle a tracker past the remote-image setting.
		const out = rewriteEmailImages(
			'<img src="/api/image-proxy?url=https%3A%2F%2Ft.test%2Fp.gif"><img src="logo.png">' +
				'<div style="background:url(/api/x)">x</div>',
			ctx()
		);
		expect(out).not.toContain('/api/image-proxy?url=https%3A%2F%2Ft.test');
		expect(out).not.toContain('/api/x');
		expect(out).not.toContain('logo.png');
		expect(out).toContain('src="about:invalid"');
	});

	it('routes SVG <image> references through the same rules', () => {
		const out = rewriteEmailImages(
			'<svg><image href="https://a.test/1.png"/><image xlink:href="/api/x"/></svg>',
			ctx()
		);
		expect(out).toContain(`href="${proxied('https://a.test/1.png')}"`);
		expect(out).toContain('xlink:href="about:invalid"');
	});

	it('does not stop at a ">" inside a quoted attribute', () => {
		const out = rewriteEmailImages('<img alt="a > b" src="https://a.test/1.png">', ctx());
		expect(out).toBe(`<img alt="a > b" src="${proxied('https://a.test/1.png')}">`);
	});

	it('drops a sender <base> and resolves relative images against it', () => {
		const out = rewriteEmailImages(
			'<base href="https://news.test/mail/"><img src="img/1.png"><a href="x">x</a>',
			ctx()
		);
		expect(out).not.toContain('<base');
		expect(out).toContain(`src="${proxied('https://news.test/mail/img/1.png')}"`);
	});

	it('skips comments, and leaves a tag that never closes (which a browser shows nothing of) alone', () => {
		const out = rewriteEmailImages(
			'<!-- <img src="https://t.test/c.png"> --><img src="https://a.test/1.png"><img src="https://t.test/open',
			ctx()
		);
		expect(out).toContain('<!-- <img src="https://t.test/c.png"> -->');
		expect(out).toContain(`src="${proxied('https://a.test/1.png')}"`);
		expect(out).toContain('<img src="https://t.test/open');
	});
});

describe('prepareEmailForReading on hostile input', () => {
	const SIZE = 200 * 1024;
	const fill = (unit: string) => unit.repeat(Math.ceil(SIZE / unit.length));
	// Each of these made the old regexes scan to the end of the body from
	// every match: 48 KB of `<link ` took half a second, 200 KB over a minute.
	const HOSTILE: Record<string, string> = {
		'<link ': fill('<link '),
		'<a ': fill('<a '),
		'<style>': fill('<style>'),
		'<base ': fill('<base '),
		'<meta ': fill('<meta '),
		'<img src="': fill('<img src="'),
		'<!--': fill('<!--'),
		'@import': `<style>${fill('@import')}</style>`,
		'@font-face': `<style>${fill('@font-face')}</style>`,
		'@font-face{': `<style>${fill('@font-face{')}</style>`,
		'url(': `<style>${fill('url(')}</style>`,
		'url("': `<style>${fill('url("')}</style>`,
		'style="url(': fill('<p style="url(')
	};

	// Warm up both scanners, so the first measurement is not paying for the
	// JIT compiling them.
	prepareEmailForReading(
		'<style>' + 'url(url("x")'.repeat(200) + '</style>' +
			'<img src="https://t.test/x.png" style="background:url(https://t.test/b.png)">'.repeat(200),
		{ ...ctx(), remote: 'block' }
	);

	// The quickest of a few runs: what the code costs, not what a garbage
	// collection that happens to land inside one run costs.
	function quickest(run: () => void, runs = 3): number {
		let best = Infinity;
		for (let i = 0; i < runs; i++) {
			const started = performance.now();
			run();
			best = Math.min(best, performance.now() - started);
		}
		return best;
	}

	for (const [name, body] of Object.entries(HOSTILE)) {
		it(`prepares 200 KB of ${name} in linear time`, () => {
			let html = '';
			const ms = quickest(() => {
				html = prepareEmailForReading(body, { ...ctx(), remote: 'block' }).html;
			});
			expect(ms).toBeLessThan(50);
			expect(typeof html).toBe('string');
		});
	}

	it('still prepares an ordinary large body quickly', () => {
		const body = '<p>Hello</p><img src="https://t.test/x.png" style="background:url(https://t.test/b.png)">'.repeat(2000);
		let blockedRemote = 0;
		const ms = quickest(() => {
			blockedRemote = prepareEmailForReading(body, { ...ctx(), remote: 'block' }).blockedRemote;
		});
		expect(ms).toBeLessThan(200);
		expect(blockedRemote).toBe(4000);
	});

	it('shows a body past the size cap as text instead of laying it out', () => {
		const body = '<img src="https://t.test/x.png">'.repeat(MAX_HTML_LENGTH / 32 + 1);
		const { html, blockedRemote, inlineBlobIds } = prepareEmailForReading(body, { ...ctx(), remote: 'proxy' });
		expect(html.startsWith('<pre')).toBe(true);
		expect(html).not.toContain('<img');
		expect(html).not.toContain('/api/image-proxy');
		expect(blockedRemote).toBe(0);
		expect(inlineBlobIds.size).toBe(0);
	});
});

describe('prepareEmailForReading', () => {
	const TRACKERS =
		'<img src="https://t.test/open.gif"><img srcset="https://t.test/a.png 1x, https://t.test/b.png 2x">' +
		'<td background="//t.test/bg.png" style="background-image:url(https://t.test/s.png)">x</td>' +
		'<style>.h{background:url("https://t.test/h.jpg")}</style>' +
		'<video poster="https://t.test/p.jpg"></video><input type="image" src="https://t.test/i.png">' +
		'<svg><image href="https://t.test/svg.png"/></svg>';

	it('proxies remote images when they are allowed', () => {
		const { html, blockedRemote } = prepareEmailForReading(TRACKERS, { ...ctx(), remote: 'proxy' });
		expect(blockedRemote).toBe(0);
		expect(html).toContain(`src="${proxied('https://t.test/open.gif')}"`);
		expect(html).not.toMatch(/(src|srcset|background|poster|href)="(https?:)?\/\/t\.test/);
	});

	it('blocks every remote image when they are not, and counts them', () => {
		const { html, blockedRemote } = prepareEmailForReading(TRACKERS, { ...ctx(), remote: 'block' });
		expect(html).not.toContain('t.test');
		expect(html).not.toContain('/api/image-proxy');
		expect(blockedRemote).toBe(9);
	});

	it('still shows inline cid: images and data: images when remote ones are blocked', () => {
		const { html, blockedRemote } = prepareEmailForReading(
			'<img src="cid:logo@x"><img src="data:image/png;base64,AAAA">',
			{ ...ctx([{ cid: 'logo@x', blobId: 'B1', name: 'logo.png', type: 'image/png' }]), remote: 'block' }
		);
		expect(blockedRemote).toBe(0);
		expect(html).toContain('/api/email/M1/attachment/B1');
		expect(html).toContain('data:image/png;base64,AAAA');
	});

	it('reports which parts the body draws inline, by blob id', () => {
		const { inlineBlobIds } = prepareEmailForReading(
			'<img src="cid:logo@x"><a href="cid:doc@x">the document</a><p style="background:url(cid:bg@x)">x</p>',
			ctx([
				{ cid: 'logo@x', blobId: 'B1', name: 'logo.png', type: 'image/png', disposition: 'inline' },
				{ cid: 'doc@x', blobId: 'B2', name: 'doc.pdf', type: 'application/pdf', disposition: 'attachment' },
				{ cid: 'bg@x', blobId: 'B3', name: 'bg.png', type: 'image/png', disposition: 'inline' },
				{ cid: 'unused@x', blobId: 'B4', name: 'spare.png', type: 'image/png', disposition: 'inline' }
			])
		);
		// A link to a part is not a picture of it, and B4 is never referenced.
		expect([...inlineBlobIds].sort()).toEqual(['B1', 'B3']);
	});

	it('removes <link> tags and meta refreshes, which load or navigate outside CSP image rules', () => {
		const { html } = prepareEmailForReading(
			'<link rel="stylesheet" href="https://t.test/s.css"><link rel=dns-prefetch href=//t.test>' +
				'<LINK REL="preconnect" HREF="https://t.test"/>' +
				'<meta http-equiv="refresh" content="0;url=https://t.test/opened">' +
				"<meta http-equiv='Refresh' content='5'><meta charset=\"utf-8\"><p>Hello</p>",
			{ ...ctx(), remote: 'proxy' }
		);
		expect(html).not.toMatch(/<link|refresh|t\.test/i);
		expect(html).toContain('<meta charset="utf-8">');
		expect(html).toContain('<p>Hello</p>');
	});
});

describe('emailFrameCsp', () => {
	const ORIGIN = 'https://mail.example.test';

	it('only lets images load from attachments, the proxy (when allowed) and inline data', () => {
		const csp = emailFrameCsp(ORIGIN, true);
		expect(csp).toContain("default-src 'none'");
		expect(csp).toContain(`img-src ${ORIGIN}/api/email/ ${ORIGIN}/api/image-proxy data: blob:`);
		expect(csp).toContain("style-src 'unsafe-inline'");
		expect(csp).toContain("font-src data:");
		expect(csp).toContain("media-src 'none'");
		expect(csp).toContain("frame-src 'none'");
		expect(csp).toContain("form-action 'none'");
	});

	it('leaves the image proxy out entirely when remote images are blocked', () => {
		const csp = emailFrameCsp(ORIGIN, false);
		expect(csp).not.toContain('image-proxy');
		expect(csp).toContain(`img-src ${ORIGIN}/api/email/ data: blob:`);
	});

	it('refuses an origin that could break out of the policy', () => {
		expect(() => emailFrameCsp("https://x.test; script-src 'unsafe-inline'", true)).toThrow();
		expect(() => emailFrameCsp('javascript:alert(1)', true)).toThrow();
	});
});
