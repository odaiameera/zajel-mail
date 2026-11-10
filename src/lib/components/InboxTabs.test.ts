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

// jsdom lays nothing out, so lay the strip out the way a narrow column
// does: the tabs sit side by side, the one with the underline keeps its
// label (120 wide) and the others fold to an icon (60 wide). The underline
// is inset 8px each side of its tab. Read from the DOM as it is when
// measured, so a measurement after a switch sees the strip reflowed.
function stubLayout() {
	vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
		const link = this.closest('a');
		if (!link) return DOMRect.fromRect({ x: 0, y: 0, width: 0, height: 0 });
		let x = 0;
		for (const sibling of link.parentElement!.children) {
			const width = sibling.querySelector('[data-tab-underline]') ? 120 : 60;
			if (sibling === link) {
				return this === link
					? DOMRect.fromRect({ x, y: 0, width, height: 40 })
					: DOMRect.fromRect({ x: x + 8, y: 40, width: width - 16, height: 2 });
			}
			x += width;
		}
		throw new Error('tab not in its strip');
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
		// From under Important, folded to an icon now (x 8, 44 wide), to
		// under Promotions (x 188, 104 wide).
		const [keyframes, options] = animate.mock.calls[0];
		expect(keyframes[0].transform).toBe(`translateX(-180px) scaleX(${44 / 104})`);
		expect(keyframes[1].transform).toBe('none');
		expect(options.duration).toBeGreaterThanOrEqual(200);
		expect(options.duration).toBeLessThanOrEqual(300);
	});

	it('leaves from under the old tab where the strip has put it, not where it was', async () => {
		// Promotions sat at x 180 with its label; once Important takes the
		// label, Promotions folds and moves to x 240. The underline has to
		// leave from there, or it starts under a tab it never belonged to.
		const { rerender } = render(InboxTabs, { tabs: tabs('promotions') });
		await rerender({ tabs: tabs('important') });
		const [keyframes] = animate.mock.calls[0];
		expect(keyframes[0].transform).toBe(`translateX(240px) scaleX(${44 / 104})`);
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

	it('stays on the tab the list shows while another one loads', () => {
		mocks.navigating.to = {
			url: new URL('http://localhost/inbox?category=promotions'),
			route: { id: '/(app)/inbox' }
		};
		render(InboxTabs, { tabs: tabs('important') });
		expect(underlines()[0].closest('a')).toBe(tab('Important'));
		expect(tab('Important').getAttribute('aria-current')).toBe('page');
	});

	it('follows the list when a refresh cuts a tab switch off', async () => {
		// invalidateAll() during a tab's load aborts that navigation without
		// clearing `navigating`, so a stale target must not hold the strip.
		mocks.navigating.to = {
			url: new URL('http://localhost/inbox?category=updates'),
			route: { id: '/(app)/inbox' }
		};
		const { rerender } = render(InboxTabs, { tabs: tabs('important') });
		await rerender({ tabs: { active: 'important', unread: { ...unread, important: 3 } } });
		expect(underlines()[0].closest('a')).toBe(tab('Important'));
		expect(animate).not.toHaveBeenCalled();
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
