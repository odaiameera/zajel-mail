/**
 * Single source of truth for the settings sidebar. Adding or moving a
 * page means editing this file — never hardcode nav items in the
 * layout template.
 */
export type SettingsNavGroup =
	| 'Account & Identity'
	| 'Mail'
	| 'Organization'
	| 'Advanced';

export interface SettingsNavItem {
	slug: string;
	label: string;
	group: SettingsNavGroup;
}

export const SETTINGS_NAV: SettingsNavItem[] = [
	{ slug: 'account',            group: 'Account & Identity', label: 'Account' },
	{ slug: 'accounts',           group: 'Account & Identity', label: 'Accounts' },
	{ slug: 'signatures',         group: 'Account & Identity', label: 'Signatures' },
	{ slug: 'security',           group: 'Account & Identity', label: 'Security' },

	{ slug: 'appearance',         group: 'Mail',               label: 'Appearance' },
	{ slug: 'messages',           group: 'Mail',               label: 'Messages' },
	{ slug: 'composer',           group: 'Mail',               label: 'Composer' },
	{ slug: 'notifications',      group: 'Mail',               label: 'Notifications' },
	{ slug: 'auto-reply',         group: 'Mail',               label: 'Auto-reply' },

	{ slug: 'folders',            group: 'Organization',       label: 'Folders' },
	{ slug: 'labels',             group: 'Organization',       label: 'Labels' },
	{ slug: 'rules',              group: 'Organization',       label: 'Filters & Rules' },
	{ slug: 'jev',                group: 'Organization',       label: 'Jev' },
	{ slug: 'calendar',           group: 'Organization',       label: 'Calendar' },

	{ slug: 'import-export',      group: 'Advanced',           label: 'Import / Export' },
	{ slug: 'reset',              group: 'Advanced',           label: 'Reset' },
	{ slug: 'keyboard-shortcuts', group: 'Advanced',           label: 'Keyboard shortcuts' }
];

export const SETTINGS_GROUP_ORDER: SettingsNavGroup[] = [
	'Account & Identity',
	'Mail',
	'Organization',
	'Advanced'
];

/** The nav items under their group headings, in display order. */
export function groupedSettingsNav(): (readonly [SettingsNavGroup, SettingsNavItem[]])[] {
	const map = new Map<SettingsNavGroup, SettingsNavItem[]>();
	for (const item of SETTINGS_NAV) {
		const list = map.get(item.group) ?? [];
		list.push(item);
		map.set(item.group, list);
	}
	return SETTINGS_GROUP_ORDER.filter((g) => map.has(g)).map((g) => [g, map.get(g)!] as const);
}
