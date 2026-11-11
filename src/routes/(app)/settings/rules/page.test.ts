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
});
