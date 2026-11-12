import { describe, expect, it } from 'vitest';
import { buildJmapFilter, type FilterContext } from './build-filter';
import { parseSearch } from './parse';

const ctx: FilterContext = { mailboxesByRole: { inbox: 'IN', archive: 'AR' }, labelsByName: {}, foldersByName: {} };
const filterFor = (raw: string, context = ctx) => buildJmapFilter(parseSearch(raw), context);
/** What a filter that can match nothing looks like. */
const NOTHING = { operator: 'AND', conditions: [{ hasKeyword: '$seen' }, { notKeyword: '$seen' }] };
const OTHER_TABS = [{ hasKeyword: '$cat_updates' }, { hasKeyword: '$cat_newsletters' }, { hasKeyword: '$cat_promotions' }];

describe('tab: as a mail server filter', () => {
	it('is the Inbox and that tab’s keyword', () => {
		expect(filterFor('tab:updates')).toEqual({ operator: 'AND', conditions: [{ inMailbox: 'IN' }, { hasKeyword: '$cat_updates' }] });
		expect(filterFor('tab:newsletters')).toEqual({ operator: 'AND', conditions: [{ inMailbox: 'IN' }, { hasKeyword: '$cat_newsletters' }] });
		expect(filterFor('tab:promotions')).toEqual({ operator: 'AND', conditions: [{ inMailbox: 'IN' }, { hasKeyword: '$cat_promotions' }] });
	});

	it('is, for Important, the Inbox with none of the other tabs’ keywords', () => {
		expect(filterFor('tab:important')).toEqual({
			operator: 'AND',
			conditions: [{ inMailbox: 'IN' }, { operator: 'NOT', conditions: OTHER_TABS }]
		});
	});

	it('works quoted, as the pill writes it', () => {
		expect(filterFor('tab:"updates"')).toEqual(filterFor('tab:updates'));
	});

	it('leaves an unknown tab out of the filter, as for is:', () => {
		expect(filterFor('tab:social')).toBeNull();
		expect(filterFor('tab:social invoice')).toEqual({ text: 'invoice' });
	});

	it('combines with from: and free text', () => {
		expect(filterFor('tab:updates from:bank statement')).toEqual({
			operator: 'AND',
			conditions: [{ operator: 'AND', conditions: [{ inMailbox: 'IN' }, { hasKeyword: '$cat_updates' }] }, { from: 'bank' }, { text: 'statement' }]
		});
	});

	it('matches nothing on an account with no Inbox', () => {
		expect(filterFor('tab:updates', { ...ctx, mailboxesByRole: { archive: 'AR' } })).toEqual(NOTHING);
	});
});
