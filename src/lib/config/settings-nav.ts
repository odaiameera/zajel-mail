/**
 * Single source of truth for the settings menu. Adding or moving a page
 * means editing this file — never hardcode nav items in the layout
 * template.
 *
 * The menu has no headings: pages that belong together sit in a cluster,
 * and the clusters are set apart by space. Each page also lists what is on
 * it, by the words on its rows, so the menu's search can find a setting
 * without knowing which page holds it.
 */

/** Something on a page that search can land on. `hash` is the section it is in. */
export interface SettingsTopic {
	label: string;
	hash?: string;
}

export interface SettingsNavItem {
	slug: string;
	label: string;
	/** Which cluster of the menu it sits in, top to bottom. */
	cluster: number;
	topics: SettingsTopic[];
}

const topics = (hash: string | undefined, ...labels: string[]): SettingsTopic[] =>
	labels.map((label) => (hash ? { label, hash } : { label }));

export const SETTINGS_NAV: SettingsNavItem[] = [
	{
		slug: 'accounts',
		cluster: 0,
		label: 'Accounts',
		topics: [...topics('you', 'Photo', 'Name'), ...topics('mail-accounts', 'Mail accounts', 'Add account', 'Account color')]
	},

	{
		slug: 'appearance',
		cluster: 1,
		label: 'Appearance',
		topics: topics(undefined, 'Theme', 'Density', 'Reading pane')
	},
	{
		slug: 'messages',
		cluster: 1,
		label: 'Messages & composer',
		topics: [
			...topics('inbox', 'Sort', 'Messages per page'),
			...topics('opening-mail', 'Mark as read', 'Remote images'),
			...topics('trash', 'Empty Trash', 'Sign-in codes'),
			...topics('composer', 'Undo send', 'Font', 'Font size', 'Save drafts'),
			...topics('more', 'Signatures', 'Out of office', 'Automatic replies')
		]
	},
	{
		slug: 'notifications',
		cluster: 1,
		label: 'Notifications',
		topics: [
			...topics(undefined, 'Push', 'Devices', 'Folders'),
			...topics('calendar', 'Event reminders'),
			...topics('telegram', 'Telegram')
		]
	},
	{
		slug: 'calendar',
		cluster: 1,
		label: 'Calendar',
		topics: topics(undefined, 'Week starts on')
	},

	{
		slug: 'folders-labels',
		cluster: 2,
		label: 'Folders & labels',
		topics: [...topics('folders', 'Folders'), ...topics('labels', 'Labels'), ...topics('rules', 'Rules')]
	},
	{
		slug: 'inbox-tabs',
		cluster: 2,
		label: 'Inbox tabs',
		topics: [
			...topics('tabs', 'Show tabs'),
			...topics('jev-heading', 'Jev'),
			...topics('pinned-senders', 'Pinned senders'),
			...topics('spam-heading', 'Spam checks')
		]
	},
	{
		slug: 'assistant',
		cluster: 2,
		label: 'Assistant',
		topics: [
			...topics('assistant', 'Provider', 'Model'),
			...topics('jobs', 'Scheduled jobs'),
			...topics('activity', 'Activity'),
			...topics('search', 'Semantic search', 'Ollama')
		]
	},

	{
		slug: 'security',
		cluster: 3,
		label: 'Security',
		topics: topics(undefined, 'Password', 'Authenticator app', 'Recovery codes', 'Passkeys', 'Sessions')
	},
	{
		slug: 'backup',
		cluster: 3,
		label: 'Backup & reset',
		topics: [...topics('export', 'Export'), ...topics('import', 'Import'), ...topics('reset', 'Reset')]
	}
];

/** The pages cluster by cluster, in display order. */
export function clusteredSettingsNav(): SettingsNavItem[][] {
	const clusters: SettingsNavItem[][] = [];
	for (const item of SETTINGS_NAV) (clusters[item.cluster] ??= []).push(item);
	return clusters.filter(Boolean);
}

/** The page a path under /settings belongs to: itself, or the page it hangs off (/settings/messages/signatures). */
export function settingsPageFor(pathname: string): SettingsNavItem | null {
	const slug = pathname.match(/^\/settings\/([^/]+)/)?.[1];
	return SETTINGS_NAV.find((item) => item.slug === slug) ?? null;
}

export interface SettingsSearchResult {
	/** What matched: the page's name, or a setting on it. */
	label: string;
	/** The page it is on, when the match is a setting. */
	page?: string;
	href: string;
}

/**
 * What the menu's search finds: pages by name first, then settings by the
 * words on their rows. Every word typed has to be in the match.
 */
export function searchSettings(query: string): SettingsSearchResult[] {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (words.length === 0) return [];
	const matches = (text: string) => {
		const lower = text.toLowerCase();
		return words.every((word) => lower.includes(word));
	};
	const pages: SettingsSearchResult[] = [];
	const settings: SettingsSearchResult[] = [];
	for (const item of SETTINGS_NAV) {
		const href = `/settings/${item.slug}`;
		if (matches(item.label)) pages.push({ label: item.label, href });
		for (const topic of item.topics) {
			if (matches(topic.label)) {
				settings.push({ label: topic.label, page: item.label, href: topic.hash ? `${href}#${topic.hash}` : href });
			}
		}
	}
	return [...pages, ...settings];
}
