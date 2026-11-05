import { describe, expect, it } from 'vitest';
import { markdownPieces, markdownToTelegram, MAX_MESSAGES, MESSAGE_LIMIT, packMessages, plainPiece, visibleLength } from './format';

describe('Markdown for Telegram', () => {
	it('turns the agent’s Markdown into the tags Telegram shows', () => {
		// The hourly watch's own report, which arrived with its asterisks showing.
		const reply = [
			'**Elaine hasn’t replied yet.** Nothing from `e.mcelhone@home-club.com` has arrived today.',
			'',
			'- **The only match** is your *own* email in Sent Items.',
			'- I also searched by ~~address~~ subject.',
			'',
			'## Next',
			'',
			'1. Wait',
			'2. Call her'
		].join('\n');
		expect(markdownToTelegram(reply)).toBe(
			[
				'<b>Elaine hasn’t replied yet.</b> Nothing from <code>e.mcelhone@home-club.com</code> has arrived today.',
				'',
				'• <b>The only match</b> is your <i>own</i> email in Sent Items.',
				'• I also searched by <s>address</s> subject.',
				'',
				'<b>Next</b>',
				'',
				'1. Wait',
				'2. Call her'
			].join('\n')
		);
	});

	it('keeps a list’s own numbering, nesting, and task boxes', () => {
		expect(markdownToTelegram('7. Seventh\n8. Eighth\n   - under it\n\n- [x] done\n- [ ] not yet')).toBe(
			'7. Seventh\n8. Eighth\n   • under it\n\n• ☑ done\n• ☐ not yet'
		);
	});

	it('lets nothing through as HTML: tags, entities and code come out as text', () => {
		expect(markdownToTelegram('Hi <b onclick="x">there</b> & <script>alert(1)</script>')).toBe(
			'Hi &lt;b onclick="x"&gt;there&lt;/b&gt; &amp; &lt;script&gt;alert(1)&lt;/script&gt;'
		);
		expect(markdownToTelegram('`a < b && c`')).toBe('<code>a &lt; b &amp;&amp; c</code>');
		expect(markdownToTelegram('```\nif (a < b) {}\n```')).toBe('<pre>if (a &lt; b) {}</pre>');
		expect(markdownToTelegram('<div>raw block</div>')).toBe('&lt;div&gt;raw block&lt;/div&gt;');
	});

	it('shows where a link goes instead of hiding it behind its words', () => {
		// Mail shapes what the model writes: "[Your bank](https://evil…)" must not pass as the bank.
		expect(markdownToTelegram('Check [your bank](https://evil.example/login?a=1&b=2)')).toBe(
			'Check your bank (https://evil.example/login?a=1&amp;b=2)'
		);
		expect(markdownToTelegram('See https://example.test/a and d@example.test')).toBe('See https://example.test/a and d@example.test');
		expect(markdownToTelegram('Write to [Dana](mailto:d@example.test)')).toBe('Write to Dana (d@example.test)');
		expect(markdownToTelegram('![tracking pixel](https://evil.example/p.gif)')).toBe('tracking pixel');
	});

	it('quotes once, since Telegram can’t nest quotes, and lays a table out in lines', () => {
		expect(markdownToTelegram('> She said\n>\n> > hi')).toBe('<blockquote>She said\n\nhi</blockquote>');
		expect(markdownToTelegram('| From | Subject |\n|---|---|\n| Dana | Contract |\n| Sam | Lunch |')).toBe(
			'<b>From | Subject</b>\nDana | Contract\nSam | Lunch'
		);
	});

	it('has nothing to say for an empty reply', () => {
		expect(markdownPieces('')).toEqual([]);
		expect(markdownPieces('   \n\n')).toEqual([]);
	});
});

describe('packing a report into messages', () => {
	it('counts what Telegram counts: no tags, an entity as one character', () => {
		expect(visibleLength('<b>a &amp; b</b>')).toBe(5);
	});

	it('puts a short report in one message under its title', () => {
		expect(packMessages('<b>Morning</b>', [...markdownPieces('Hello\n\nWorld'), plainPiece('• Archived 2'), plainPiece('• Starred 1', true)])).toEqual([
			'<b>Morning</b>\nHello\n\nWorld\n\n• Archived 2\n• Starred 1'
		]);
	});

	it('sends a long report whole, split between list items, every message within the limit', () => {
		// The newsletter summary was cut at 1,500 characters, mid-word.
		const items = Array.from({ length: 40 }, (_, i) => `${i + 1}. **Newsletter ${i + 1}**: ${'a short summary of it. '.repeat(8)}`);
		const messages = packMessages('<b>Daily newsletter summary</b>', markdownPieces(`It lists **40 newsletters**:\n\n${items.join('\n')}`));
		expect(messages.length).toBeGreaterThan(1);
		for (const message of messages) expect(visibleLength(message)).toBeLessThanOrEqual(MESSAGE_LIMIT);
		expect(messages[0]).toMatch(/^<b>Daily newsletter summary<\/b>\nIt lists <b>40 newsletters<\/b>:\n\n1\. /);
		// Every item arrives, each in one piece, and each message starts on an item.
		const joined = messages.join('\n');
		for (let i = 1; i <= 40; i += 1) expect(joined).toContain(`${i}. <b>Newsletter ${i}</b>: a short summary`);
		for (const message of messages.slice(1)) expect(message).toMatch(/^\d+\. <b>Newsletter/);
	});

	it('cuts a block too long for any message at a line break, as text', () => {
		const lines = Array.from({ length: 300 }, (_, i) => `line ${i} ${'x'.repeat(20)}`).join('\n');
		const messages = packMessages('<b>Log</b>', markdownPieces(`\`\`\`\n${lines}\n\`\`\``));
		expect(messages.length).toBeGreaterThan(1);
		for (const message of messages) expect(visibleLength(message)).toBeLessThanOrEqual(MESSAGE_LIMIT);
		expect(messages.join('\n')).toContain('line 299 ');
		expect(messages[1]).toMatch(/^line \d+ x+\n/);
	});

	it('stops a flood, and says it was cut', () => {
		const huge = Array.from({ length: 400 }, (_, i) => `Paragraph ${i}. ${'words '.repeat(30)}`).join('\n\n');
		const messages = packMessages('<b>Too much</b>', markdownPieces(huge));
		expect(messages).toHaveLength(MAX_MESSAGES);
		expect(messages[MAX_MESSAGES - 1]).toMatch(/cut here: the rest is too long for Telegram\.<\/i>$/);
		for (const message of messages) expect(visibleLength(message)).toBeLessThan(4096);
	});
});
