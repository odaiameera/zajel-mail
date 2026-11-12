import { describe, expect, it } from 'vitest';
import { SETTINGS_NAV, clusteredSettingsNav, searchSettings, settingsPageFor } from './settings-nav';

describe('the settings menu', () => {
	it('has ten pages in four clusters, with no headings', () => {
		expect(clusteredSettingsNav().map((cluster) => cluster.map((item) => item.label))).toEqual([
			['Accounts'],
			['Appearance', 'Messages & composer', 'Notifications', 'Calendar'],
			['Folders & labels', 'Inbox tabs', 'Assistant'],
			['Security', 'Backup & reset']
		]);
	});

	it('no longer lists the pages that were folded into others', () => {
		const slugs = SETTINGS_NAV.map((item) => item.slug);
		for (const gone of [
			'account', 'signatures', 'composer', 'auto-reply', 'search', 'agent', 'import-export', 'reset',
			'folders', 'labels', 'rules', 'jev'
		]) {
			expect(slugs).not.toContain(gone);
		}
	});

	it('knows which page a path under it belongs to', () => {
		expect(settingsPageFor('/settings/messages')?.slug).toBe('messages');
		expect(settingsPageFor('/settings/messages/signatures')?.slug).toBe('messages');
		expect(settingsPageFor('/settings')).toBeNull();
		expect(settingsPageFor('/settings/nowhere')).toBeNull();
	});
});

describe('searching the settings', () => {
	it('finds a page by its name', () => {
		expect(searchSettings('appear')).toEqual([{ label: 'Appearance', href: '/settings/appearance' }]);
	});

	it('finds a setting by the words on its row, and says which page and section it is on', () => {
		expect(searchSettings('undo')).toEqual([
			{ label: 'Undo send', page: 'Messages & composer', href: '/settings/messages#composer' }
		]);
		expect(searchSettings('signatures')).toContainEqual({
			label: 'Signatures',
			page: 'Messages & composer',
			href: '/settings/messages#more'
		});
	});

	it('wants every word typed, in any case, and finds nothing for nothing', () => {
		expect(searchSettings('SEND undo').map((r) => r.label)).toEqual(['Undo send']);
		expect(searchSettings('undo zebra')).toEqual([]);
		expect(searchSettings('   ')).toEqual([]);
	});

	it('lists pages before settings', () => {
		const results = searchSettings('calendar');
		expect(results[0]).toEqual({ label: 'Calendar', href: '/settings/calendar' });
	});
});
