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
	},
	tabNote: { tab: 'updates', why: 'not_one_sender' }
};

// A rule that only put one sender's mail in a tab: it became that sender's pin.
const becamePin: Rule = {
	id: 'became-pin',
	name: 'Amazon to Promotions',
	enabled: false,
	logic: 'allof',
	conditions: [{ id: 'c5', field: 'from', op: 'contains', value: '@amazon.co', negate: false }],
	actions: [],
	createdAt: 5,
	attention: 'tab_pinned',
	legacy: {
		enabled: true,
		logic: 'allof',
		conditions: [{ id: 'c5', field: 'from', op: 'contains', value: '@amazon.co', negate: false }] as never,
		actions: [{ type: 'setCategory', value: 'promotions' }]
	},
	tabNote: { tab: 'promotions', pin: { sender: '@amazon.co', category: 'promotions' }, op: 'contains', said: '@amazon.co' }
};

// A tab rule for a sender that was already pinned to another tab: the pin was kept.
const pinnedElsewhere: Rule = {
	id: 'pinned-elsewhere',
	name: 'Shop news to Updates',
	enabled: false,
	logic: 'allof',
	conditions: [{ id: 'c6', field: 'from', op: 'contains', value: 'news@shop.example', negate: false }],
	actions: [],
	createdAt: 6,
	attention: 'tab_rule',
	legacy: {
		enabled: true,
		logic: 'allof',
		conditions: [{ id: 'c6', field: 'from', op: 'contains', value: 'news@shop.example', negate: false }] as never,
		actions: [{ type: 'setCategory', value: 'updates' }]
	},
	tabNote: {
		tab: 'updates',
		pin: { sender: 'news@shop.example', category: 'updates' },
		op: 'contains',
		said: 'news@shop.example',
		why: 'pinned_elsewhere',
		kept: { sender: 'news@shop.example', category: 'promotions' }
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

/** Pins the page asked for, in order with the saves (see stubFetch). */
let pinned: { sender: string; category: string; savesBefore: number }[] = [];
/** Whether the pins endpoint answers; a test turns it off. */
let pinsWork = true;

/** The page's requests, answered; returns the rules it saved, newest last. */
function stubFetch(): Rule[][] {
	const saved: Rule[][] = [];
	pinned = [];
	pinsWork = true;
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string, init?: RequestInit) => {
			if (url === '/api/preferences/rules') saved.push(JSON.parse(String(init?.body)).rules);
			if (url === '/api/jev/pins') {
				if (!pinsWork) return new Response(JSON.stringify({ error: 'Unknown account' }), { status: 404 });
				pinned.push({ ...JSON.parse(String(init?.body)), savesBefore: saved.length });
			}
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
		expect(screen.getByText('This rule no longer puts mail in the Newsletters tab.')).toBeTruthy();
		expect(screen.getByText(/It used to move mail to the Newsletters tab as well/)).toBeTruthy();

		await fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
		await waitFor(() => expect(saved).toHaveLength(1));

		expect(saved[0][0]).toMatchObject({ id: 'tab-removed', enabled: true, actions: [{ type: 'markRead' }] });
		expect(saved[0][0]).not.toHaveProperty('attention');
		expect(saved[0][0]).not.toHaveProperty('legacy');
		await waitFor(() => expect(screen.queryByRole('heading', { name: 'Needs your attention' })).toBeNull());
	});

	it('says which pin a rule became and exactly what that pin matches, and removes what is left on "Got it"', async () => {
		const saved = stubFetch();
		page([exact, becamePin]);

		const list = screen.getByRole('heading', { name: 'Needs your attention' }).nextElementSibling as HTMLElement;
		// Switched off for good: no switch to turn it back on with.
		expect(within(list).queryByRole('button', { name: /able rule/ })).toBeNull();
		await fireEvent.click(within(list).getByText('Amazon to Promotions'));

		expect(screen.getByText('This rule became a sender pin: @amazon.co → Promotions.')).toBeTruthy();
		// What the pin acts on, and that it is less than the rule matched.
		expect(screen.getByText(/The pin acts on new mail from any address at amazon\.co \(the part after the @ has to be exactly that/)).toBeTruthy();
		expect(screen.getByText(/The rule matched any sender containing “@amazon\.co”; the pin matches only that domain\./)).toBeTruthy();
		// Nothing to edit or save: it is a note, not a rule.
		expect(screen.queryByLabelText('Name')).toBeNull();
		expect(screen.queryByRole('button', { name: 'Save as exact rule' })).toBeNull();

		await fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
		await waitFor(() => expect(saved).toHaveLength(1));
		expect(saved[0].map((r) => r.id)).toEqual(['exact']);
	});

	it('says why a tab rule wasn’t pinned, and pins it with one click, removing the rule', async () => {
		const saved = stubFetch();
		page([exact, pinnedElsewhere]);
		await fireEvent.click(screen.getByText('Shop news to Updates'));

		// The existing pin was kept, and the rule's tab not applied: said in so many words.
		expect(
			screen.getByText('news@shop.example is already pinned to Promotions, which was kept. This rule’s tab (Updates) is no longer applied.')
		).toBeTruthy();

		await fireEvent.click(screen.getByRole('button', { name: 'Pin to Updates instead' }));
		await waitFor(() => expect(saved).toHaveLength(1));

		// The pin first, then the rules without the rule.
		expect(pinned).toEqual([{ sender: 'news@shop.example', category: 'updates', savesBefore: 0 }]);
		expect(saved[0].map((r) => r.id)).toEqual(['exact']);
	});

	it('keeps the rule when the pin couldn’t be saved', async () => {
		const saved = stubFetch();
		pinsWork = false;
		page([pinnedElsewhere]);

		await fireEvent.click(screen.getByRole('button', { name: 'Pin to Updates instead' }));

		await waitFor(() => expect(screen.getByText('Unknown account')).toBeTruthy());
		expect(saved).toEqual([]);
		expect(screen.getByRole('heading', { name: 'Needs your attention' })).toBeTruthy();
	});

	it('offers no one-click pin for a tab rule that names no sender', async () => {
		stubFetch();
		page([tabOnly]);
		expect(screen.queryByRole('button', { name: /^Pin / })).toBeNull();
		expect(screen.getByText('Rules can’t set a tab any more. This one can’t be turned into a sender pin automatically.')).toBeTruthy();
	});

	// Each reason a tab rule was left a rule, as its owner reads it, and the one-click pin it offers.
	const sender = { id: 'c7', field: 'from', op: 'contains', value: 'news@shop.example', negate: false } as const;
	const leftAsRule = (why: string, over: Record<string, unknown> = {}): Rule => ({
		...pinnedElsewhere,
		id: `why-${why}`,
		name: `Why ${why}`,
		conditions: [sender],
		tabNote: { tab: 'updates', pin: { sender: 'news@shop.example', category: 'updates' }, op: 'contains', said: 'news@shop.example', why } as never,
		...over
	});
	it.each([
		['switched_off', 'This rule put mail in Updates. It was switched off, so no pin was made.'],
		['not_one_sender', 'Rules can’t set a tab any more. This one can’t be turned into a sender pin automatically.'],
		['after_stop', 'An earlier rule stops processing, so this rule may never have run. No pin was made.'],
		['no_account', 'No mail account was found for these rules.']
	])('explains a tab rule left as a rule because %s, and offers its pin', async (why, words) => {
		const saved = stubFetch();
		page([leftAsRule(why)]);
		expect(screen.getByText(words)).toBeTruthy();
		await fireEvent.click(screen.getByRole('button', { name: 'Pin news@shop.example to Updates' }));
		await waitFor(() => expect(saved).toHaveLength(1));
		expect(pinned).toEqual([{ sender: 'news@shop.example', category: 'updates', savesBefore: 0 }]);
		expect(saved[0]).toEqual([]);
	});

	it('offers no one-click pin when the rule’s sender is not one a pin can hold', () => {
		stubFetch();
		const word = { ...sender, value: 'shop' };
		page([leftAsRule('not_one_sender', { conditions: [word], tabNote: { tab: 'updates', why: 'not_one_sender' } })]);
		expect(screen.getByText('Rules can’t set a tab any more. This one can’t be turned into a sender pin automatically.')).toBeTruthy();
		expect(screen.queryByRole('button', { name: /^Pin / })).toBeNull();
	});

	it('says when the sender was already pinned to the rule’s tab, and removes the note on "Got it"', async () => {
		const saved = stubFetch();
		page([{ ...becamePin, tabNote: { ...becamePin.tabNote!, existing: true } }]);
		expect(screen.getByText('@amazon.co was already pinned to Promotions.')).toBeTruthy();
		expect(screen.queryByText(/This rule became a sender pin/)).toBeNull();
		await fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
		await waitFor(() => expect(saved).toEqual([[]]));
	});
});
