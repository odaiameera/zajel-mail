// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import type { InboxTabsState } from '$lib/types/categories';

const mocks = vi.hoisted(() => ({
	page: {
		url: new URL('http://localhost/inbox'),
		route: { id: '/(app)/inbox' }
	},
	navigating: { to: null as null | { url: URL; route: { id: string | null } } },
	moveToCategory: vi.fn(async () => true)
}));

vi.mock('$app/state', () => ({ page: mocks.page, navigating: mocks.navigating }));
vi.mock('$lib/categories/api', () => ({ moveToCategory: mocks.moveToCategory }));

import InboxTabs from './InboxTabs.svelte';

const unread = { important: 2, updates: 0, newsletters: 5, promotions: 0 };
const tabs = (active: InboxTabsState['active']): InboxTabsState => ({ active, unread });

const tab = (label: string) => screen.getByRole('link', { name: new RegExp(`^${label}`) });
const underlines = () => [...document.querySelectorAll<HTMLElement>('[data-tab-underline]')];

// jsdom lays nothing out, so give each tab's underline a place: tab n
// starts at 100n and is 60 wide, except Important, which is wider (it
// keeps its label when the column is narrow).
function stubLayout() {
	vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
		const link = this.closest('a');
		const index = link ? [...link.parentElement!.children].indexOf(link) : 0;
		const width = index === 0 ? 120 : 60;
		return DOMRect.fromRect({ x: 100 * index, y: 40, width, height: 2 });
	});
}

let animate: ReturnType<typeof vi.fn>;

beforeEach(() => {
	mocks.navigating.to = null;
	animate = vi.fn(() => ({ cancel: vi.fn() }));
	// jsdom has no Web Animations API.
	(HTMLElement.prototype as unknown as { animate: unknown }).animate = animate;
	stubLayout();
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	mocks.moveToCategory.mockClear();
	delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate;
});

describe('InboxTabs underline', () => {
	it('sits under the active tab from the first paint, without sliding in', () => {
		render(InboxTabs, { tabs: tabs('newsletters') });
		expect(underlines()).toHaveLength(1);
		expect(underlines()[0].closest('a')).toBe(tab('Newsletters'));
		expect(tab('Newsletters').getAttribute('aria-current')).toBe('page');
		expect(animate).not.toHaveBeenCalled();
	});

	it('glides from the old tab to the new one', async () => {
		const { rerender } = render(InboxTabs, { tabs: tabs('important') });
		await rerender({ tabs: tabs('promotions') });

		expect(underlines()).toHaveLength(1);
		const underline = underlines()[0];
		expect(underline.closest('a')).toBe(tab('Promotions'));
		expect(animate).toHaveBeenCalledTimes(1);
		expect(animate.mock.contexts[0]).toBe(underline);
		// From Important (x 0, 120 wide) to Promotions (x 300, 60 wide).
		const [keyframes, options] = animate.mock.calls[0];
		expect(keyframes[0].transform).toBe('translateX(-300px) scaleX(2)');
		expect(keyframes[1].transform).toBe('none');
		expect(options.duration).toBeGreaterThanOrEqual(200);
		expect(options.duration).toBeLessThanOrEqual(300);
	});

	it('stays still when a refresh brings the same tab back', async () => {
		const { rerender } = render(InboxTabs, { tabs: tabs('updates') });
		// The realtime layer re-runs the load: a new object, the same tab.
		await rerender({ tabs: { active: 'updates', unread: { ...unread, updates: 3 } } });
		expect(animate).not.toHaveBeenCalled();
	});

	it('moves without animating when less motion is asked for', async () => {
		vi.stubGlobal(
			'matchMedia',
			vi.fn((query: string) => ({ matches: query.includes('reduce'), media: query }))
		);
		const { rerender } = render(InboxTabs, { tabs: tabs('important') });
		await rerender({ tabs: tabs('updates') });
		expect(underlines()[0].closest('a')).toBe(tab('Updates'));
		expect(animate).not.toHaveBeenCalled();
	});

	it('follows a click straight away, before the new tab has loaded', () => {
		mocks.navigating.to = {
			url: new URL('http://localhost/inbox?category=promotions'),
			route: { id: '/(app)/inbox' }
		};
		render(InboxTabs, { tabs: tabs('important') });
		expect(underlines()[0].closest('a')).toBe(tab('Promotions'));
		// The page is still Important until its replacement arrives.
		expect(tab('Important').getAttribute('aria-current')).toBe('page');
		expect(tab('Promotions').getAttribute('aria-current')).toBeNull();
	});

	it('ignores a navigation that leaves the Inbox', () => {
		mocks.navigating.to = {
			url: new URL('http://localhost/email/abc'),
			route: { id: '/(app)/email/[id]' }
		};
		render(InboxTabs, { tabs: tabs('updates') });
		expect(underlines()[0].closest('a')).toBe(tab('Updates'));
	});
});

describe('InboxTabs drop target', () => {
	const payload = (ids: string[]) => ({
		types: ['application/x-email-ids'],
		getData: () => JSON.stringify(ids),
		dropEffect: 'none'
	});

	it('moves dropped rows to the tab, from the tab the list shows', async () => {
		render(InboxTabs, { tabs: tabs('important') });
		await fireEvent.dragOver(tab('Newsletters'), { dataTransfer: payload(['a1', 'a2']) });
		expect(tab('Newsletters').className).toContain('ring-accent');
		await fireEvent.drop(tab('Newsletters'), { dataTransfer: payload(['a1', 'a2']) });
		expect(mocks.moveToCategory).toHaveBeenCalledWith(['a1', 'a2'], 'newsletters', 'important');
		expect(tab('Newsletters').className).not.toContain('ring-accent');
	});
});
