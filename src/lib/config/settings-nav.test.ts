import { describe, expect, it } from 'vitest';
import { SETTINGS_NAV } from './settings-nav';

describe('the settings menu', () => {
	it('has Folders & labels and Inbox tabs where Folders, Labels, Filters & Rules and Jev were', () => {
		const organization = SETTINGS_NAV.filter((item) => item.group === 'Organization');
		expect(organization.map((item) => [item.slug, item.label])).toEqual([
			['folders-labels', 'Folders & labels'],
			['inbox-tabs', 'Inbox tabs'],
			['agent', 'Agent'],
			['calendar', 'Calendar']
		]);
		const slugs = SETTINGS_NAV.map((item) => item.slug);
		for (const gone of ['folders', 'labels', 'rules', 'jev']) expect(slugs).not.toContain(gone);
	});
});
