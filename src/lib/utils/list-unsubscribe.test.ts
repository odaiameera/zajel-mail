import { describe, expect, it } from 'vitest';
import { parseListUnsubscribe } from './list-unsubscribe';

describe('parseListUnsubscribe', () => {
	it('picks RFC 8058 one-click when the POST header and an HTTPS URL are both there', () => {
		expect(
			parseListUnsubscribe(
				'<mailto:leave@news.test?subject=stop>, <https://news.test/u/abc>',
				'List-Unsubscribe=One-Click'
			)
		).toEqual({ mode: 'one-click', url: 'https://news.test/u/abc' });
	});

	it('falls back to mailto, then to a page to open', () => {
		expect(parseListUnsubscribe('<mailto:leave@news.test>, <https://news.test/u>', null)).toEqual({
			mode: 'mailto',
			mailto: 'mailto:leave@news.test'
		});
		expect(parseListUnsubscribe('<http://news.test/u>', 'List-Unsubscribe=One-Click')).toEqual({
			mode: 'url',
			url: 'http://news.test/u'
		});
	});

	it('trims whitespace a folded header leaves inside the brackets', () => {
		expect(parseListUnsubscribe('< https://news.test/u/abc >', 'List-Unsubscribe=One-Click')).toEqual({
			mode: 'one-click',
			url: 'https://news.test/u/abc'
		});
	});

	it('reads the raw header form, with its leading space and folded lines', () => {
		expect(
			parseListUnsubscribe(' <mailto:leave@news.test>,\r\n\t<https://news.test/u/abc>', 'List-Unsubscribe=One-Click')
		).toEqual({ mode: 'one-click', url: 'https://news.test/u/abc' });
	});

	it('reports nothing usable as none', () => {
		expect(parseListUnsubscribe(null, null)).toEqual({ mode: 'none' });
		expect(parseListUnsubscribe('', 'List-Unsubscribe=One-Click')).toEqual({ mode: 'none' });
		expect(parseListUnsubscribe('<javascript:alert(1)>, <ftp://x.test>', null)).toEqual({ mode: 'none' });
	});
});
