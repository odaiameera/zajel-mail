import { describe, expect, it } from 'vitest';
import { SETTINGS_NAV } from './settings-nav';

describe('the settings menu', () => {
	it('has one page for folders, labels and rules, where the three were', () => {
		const organization = SETTINGS_NAV.filter((item) => item.group === 'Organization');
		expect(organization.map((item) => [item.slug, item.label])).toEqual([
			['folders-labels', 'Folders & labels'],
			['jev', 'Jev'],
			['agent', 'Agent'],
			['calendar', 'Calendar']
		]);
		const slugs = SETTINGS_NAV.map((item) => item.slug);
		for (const gone of ['folders', 'labels', 'rules']) expect(slugs).not.toContain(gone);
	});
});
