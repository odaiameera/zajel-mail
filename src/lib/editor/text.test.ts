import { describe, expect, it } from 'vitest';
import { BLANK_LINE, textToLines } from './text';

describe('textToLines', () => {
	it('writes a line per line and an empty one for a blank line', () => {
		expect(textToLines('Hi Dana,\n\nFirst.\r\nSecond.')).toBe(`<div>Hi Dana,</div>${BLANK_LINE}<div>First.</div><div>Second.</div>`);
	});

	it('lets nothing in the text be read as markup', () => {
		expect(textToLines('<img src=x onerror="a()"> & "q"')).toBe('<div>&lt;img src=x onerror=&quot;a()&quot;&gt; &amp; &quot;q&quot;</div>');
	});

	it('is empty for no text', () => {
		expect(textToLines('')).toBe('');
	});
});
