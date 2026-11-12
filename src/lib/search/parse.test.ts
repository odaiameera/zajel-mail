import { describe, expect, it } from 'vitest';
import { parseSearch } from './parse';

describe('tab: in the search box', () => {
	it('reads each of the four tabs', () => {
		for (const tab of ['important', 'updates', 'newsletters', 'promotions']) {
			expect(parseSearch(`tab:${tab}`)).toEqual([{ kind: 'field', field: 'tab', value: tab, raw: `tab:${tab}`, start: 0, end: 4 + tab.length }]);
		}
	});

	it('reads a tab in any case, as written by the pill (quoted), and names it in lower case', () => {
		expect(parseSearch('Tab:Updates')[0]).toMatchObject({ kind: 'field', field: 'tab', value: 'updates' });
		expect(parseSearch('tab:"newsletters"')[0]).toMatchObject({ kind: 'field', field: 'tab', value: 'newsletters', raw: 'tab:"newsletters"' });
	});

	it('marks a tab that doesn’t exist, or none, as an error, as it does for is:', () => {
		expect(parseSearch('tab:social')).toEqual([{ kind: 'error', raw: 'tab:social', reason: 'unknown tab: value "social"', start: 0, end: 10 }]);
		expect(parseSearch('tab:"work stuff"')[0]).toMatchObject({ kind: 'error', reason: 'unknown tab: value "work stuff"' });
		expect(parseSearch('tab:')[0]).toMatchObject({ kind: 'error', reason: 'empty value' });
		expect(parseSearch('tab:"updates')[0]).toMatchObject({ kind: 'error', reason: 'unclosed quote' });
	});

	it('sits beside other operators and free text', () => {
		expect(parseSearch('tab:updates from:bank statement').map((t) => [t.kind, t.kind === 'field' ? t.field : null, 'value' in t ? t.value : null])).toEqual([
			['field', 'tab', 'updates'],
			['field', 'from', 'bank'],
			['text', null, 'statement']
		]);
	});
});
