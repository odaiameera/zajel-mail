// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';

vi.mock('$app/navigation', () => ({ invalidateAll: vi.fn() }));

import type { Rule } from '$lib/types/rules';
import Page from './+page.svelte';

beforeEach(() => {
	// jsdom has no Web Animations API, and the page's transitions need one
	// whose animations finish.
	(HTMLElement.prototype as unknown as { animate: unknown }).animate = () => {
		const animation = { cancel() {}, onfinish: null as (() => void) | null };
		queueMicrotask(() => animation.onfinish?.());
		return animation;
	};
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate;
});

const exact: Rule = {
	id: 'exact',
	name: 'Receipts',
	enabled: true,
	logic: 'allof',
	conditions: [{ id: 'c1', field: 'from', op: 'contains', value: 'shop.example', negate: false }],
	actions: [{ type: 'markRead' }],
	createdAt: 1
};

// As the upgrade leaves a rule that had a condition Jev judged.
const flagged: Rule = {
	id: 'flagged',
	name: 'Invoices',
	enabled: false,
	logic: 'allof',
	conditions: [{ id: 'c2', field: 'from', op: 'contains', value: 'billing@', negate: false }],
	actions: [{ type: 'markRead' }],
	createdAt: 2,
	attention: 'jev_condition',
	legacy: {
		enabled: true,
		logic: 'allof',
		conditions: [
			{ id: 'c2', field: 'from', op: 'contains', value: 'billing@', negate: false },
			{ id: 'j1', field: 'jev', op: 'contains', value: 'it’s an invoice or a request for payment', negate: false, strictness: 'strict' }
		] as never,
		actions: [{ type: 'markRead' }]
	}
};

// A rule that only put mail in a tab, and wasn't a plain match on one sender.
const tabOnly: Rule = {
	id: 'tab-only',
	name: 'Digests to Updates',
	enabled: false,
	logic: 'allof',
	conditions: [{ id: 'c3', field: 'subject', op: 'contains', value: 'digest', negate: false }],
	actions: [],
	createdAt: 3,
	attention: 'tab_rule',
	legacy: {
		enabled: true,
		logic: 'allof',
		conditions: [{ id: 'c3', field: 'subject', op: 'contains', value: 'digest', negate: false }] as never,
		actions: [{ type: 'setCategory', value: 'updates' }]
	}
};

// A rule that labelled mail and put it in a tab: the label part still runs.
const tabRemoved: Rule = {
	id: 'tab-removed',
	name: 'Work mail',
	enabled: true,
	logic: 'allof',
	conditions: [{ id: 'c4', field: 'from', op: 'contains', value: '@work.example', negate: false }],
	actions: [{ type: 'markRead' }],
	createdAt: 4,
	attention: 'tab_removed',
	legacy: {
		enabled: true,
		logic: 'allof',
		conditions: [{ id: 'c4', field: 'from', op: 'contains', value: '@work.example', negate: false }] as never,
		actions: [{ type: 'markRead' }, { type: 'setCategory', value: 'newsletters' }]
	}
};

/** The page's requests, answered; returns the rules it saved, newest last. */
function stubFetch(): Rule[][] {
	const saved: Rule[][] = [];
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string, init?: RequestInit) => {
			if (url === '/api/preferences/rules') saved.push(JSON.parse(String(init?.body)).rules);
			return new Response(JSON.stringify(url === '/api/rules/preview' ? { count: 3 } : { success: true }), { status: 200 });
		})
	);
	return saved;
}

const page = (rules: Rule[]) => render(Page, { props: { data: { rules, labels: [], mailboxes: [] } } as never });

describe('Settings → Rules', () => {
	it('lists a rule that had a Jev condition under "Needs your attention", with what it said', async () => {
		stubFetch();
		page([exact, flagged]);

		const heading = screen.getByRole('heading', { name: 'Needs your attention' });
		const list = heading.nextElementSibling as HTMLElement;
		expect(within(list).getByText('Invoices')).toBeTruthy();
		expect(within(list).queryByText('Receipts')).toBeNull();
		// Switched off until it is rewritten: no switch to turn it back on with.
		expect(within(list).queryByRole('button', { name: /able rule/ })).toBeNull();

		await fireEvent.click(within(list).getByText('Invoices'));
		expect(screen.getByText('This rule is switched off')).toBeTruthy();
		expect(screen.getByText('From contains “billing@”')).toBeTruthy();
		expect(screen.getByText('Jev judged: “it’s an invoice or a request for payment” (strict)')).toBeTruthy();
	});

	it('shows no such heading when every rule is an ordinary one', () => {
		stubFetch();
		page([exact]);
		expect(screen.queryByRole('heading', { name: 'Needs your attention' })).toBeNull();
	});

	it('clears the flag and switches the rule on when it is saved as an exact rule', async () => {
		const saved = stubFetch();
		page([flagged]);

		await fireEvent.click(screen.getByRole('button', { name: 'Save as exact rule' }));
		await waitFor(() => expect(saved).toHaveLength(1));

		expect(saved[0]).toHaveLength(1);
		expect(saved[0][0]).toMatchObject({ id: 'flagged', enabled: true, conditions: flagged.conditions });
		expect(saved[0][0]).not.toHaveProperty('attention');
		expect(saved[0][0]).not.toHaveProperty('legacy');
		await waitFor(() => expect(screen.queryByRole('heading', { name: 'Needs your attention' })).toBeNull());
	});

	it('won’t save a flagged rule as exact while it has nothing to match on', async () => {
		stubFetch();
		page([{ ...flagged, conditions: [] }]);
		expect((screen.getByRole('button', { name: 'Save as exact rule' }) as HTMLButtonElement).disabled).toBe(true);
	});

	it('deletes a flagged rule when asked', async () => {
		const saved = stubFetch();
		vi.stubGlobal('confirm', () => true);
		page([exact, flagged]);

		await fireEvent.click(screen.getByText('Invoices'));
		// The button beside "Save as exact rule" (each row of the list has its own, an icon).
		await fireEvent.click(screen.getByText('Delete rule'));
		await waitFor(() => expect(saved).toHaveLength(1));
		expect(saved[0].map((r) => r.id)).toEqual(['exact']);
	});

	it('offers no "move to an Inbox tab" action: tabs are not a rule’s to set', () => {
		stubFetch();
		page([exact]);
		const options = [...document.querySelectorAll('option')].map((o) => o.textContent?.trim());
		expect(options).toContain('Apply label');
		expect(options.some((o) => /tab/i.test(o ?? ''))).toBe(false);
	});

	it('lists a rule that only set a tab, switched off, with the tab and what it matched', async () => {
		stubFetch();
		page([exact, tabOnly]);

		const list = screen.getByRole('heading', { name: 'Needs your attention' }).nextElementSibling as HTMLElement;
		await fireEvent.click(within(list).getByText('Digests to Updates'));

		expect(screen.getByText('This rule is switched off')).toBeTruthy();
		expect(screen.getByText(/All it did was move mail to the Updates tab/)).toBeTruthy();
		expect(screen.getByText('Subject contains “digest”')).toBeTruthy();
		// Nothing left for it to do: it can't be saved as a rule until it is given an action.
		expect((screen.getByRole('button', { name: 'Save as exact rule' }) as HTMLButtonElement).disabled).toBe(true);
	});

	it('notes a rule that lost only its tab, leaves it running, and drops the note when told', async () => {
		const saved = stubFetch();
		page([tabRemoved]);

		const list = screen.getByRole('heading', { name: 'Needs your attention' }).nextElementSibling as HTMLElement;
		// Still an ordinary rule, with its switch.
		expect(within(list).getByRole('button', { name: 'Disable rule' })).toBeTruthy();
		expect(screen.getByText('This rule no longer sets a tab')).toBeTruthy();
		expect(screen.getByText(/It used to move mail to the Newsletters tab as well/)).toBeTruthy();

		await fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
		await waitFor(() => expect(saved).toHaveLength(1));

		expect(saved[0][0]).toMatchObject({ id: 'tab-removed', enabled: true, actions: [{ type: 'markRead' }] });
		expect(saved[0][0]).not.toHaveProperty('attention');
		expect(saved[0][0]).not.toHaveProperty('legacy');
		await waitFor(() => expect(screen.queryByRole('heading', { name: 'Needs your attention' })).toBeNull());
	});
});
