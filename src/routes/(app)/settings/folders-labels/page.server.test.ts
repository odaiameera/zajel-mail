import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/rules/store', () => ({
	listRules: (accountId: string) => [{ id: `rule-of-${accountId}` }]
}));

import { load } from './+page.server';

describe('the folders and labels page’s load', () => {
	it('reads the active account’s rules itself, not from the app layout', async () => {
		const parent = async () => ({ labels: [], mailboxes: [], mailboxMeta: {}, rules: [{ id: 'from-the-layout' }] });
		const data = (await load({ parent, locals: { activeAccountId: 'acct' } } as never)) as { rules: { id: string }[] };
		expect(data.rules).toEqual([{ id: 'rule-of-acct' }]);
		const none = (await load({ parent, locals: {} } as never)) as { rules: unknown[] };
		expect(none.rules).toEqual([]);
	});
});
