// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/svelte';
import type { Mailbox } from '$lib/jmap/types';
import type { Rule } from '$lib/types/rules';
import RuleEditor from './RuleEditor.svelte';

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

const mailboxes = [
	{ id: 'IN', name: 'Inbox', role: 'inbox', parentId: null },
	{ id: 'TR', name: 'Trash', role: 'trash', parentId: null },
	{ id: 'RCPT', name: 'Receipts', role: null, parentId: null },
	{ id: 'LBLS', name: 'Labels', role: null, parentId: null },
	{ id: 'WORK', name: 'Work', role: null, parentId: 'LBLS' }
] as unknown as Mailbox[];
const labels = [{ id: 'WORK', name: 'Work', color: '#000' }];

const saved: Rule = {
	id: 'r1',
	name: 'Receipts',
	enabled: true,
	logic: 'allof',
	conditions: [{ id: 'c1', field: 'from', op: 'contains', value: 'shop.example', negate: false }],
	target: { kind: 'folder', mailboxId: 'RCPT' },
	markRead: false,
	star: false,
	stop: false,
	position: 0,
	createdAt: 1,
	updatedAt: 1
};

function stubPreview(answer: Record<string, unknown>) {
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => new Response(JSON.stringify(answer), { status: 200 }))
	);
}

const editor = (props: Record<string, unknown>) =>
	render(RuleEditor, {
		props: { mailboxes, labels, onSaved: () => {}, onDeleted: () => {}, onCancel: () => {}, ...props } as never
	});
const fileItIn = () => (screen.getByLabelText('File it in') as HTMLSelectElement).value;

describe('RuleEditor', () => {
	it('starts a new rule on the place it was started from', () => {
		stubPreview({ matched: 0, scanned: 0, total: 0 });
		editor({ rule: null, initialTarget: { kind: 'label', mailboxId: 'WORK' } });
		expect(fileItIn()).toBe('label:WORK');
	});

	it('starts on Trash, Archive or Junk too', () => {
		stubPreview({ matched: 0, scanned: 0, total: 0 });
		editor({ rule: null, initialTarget: { kind: 'trash' } });
		expect(fileItIn()).toBe('trash');
	});

	it('starts a new rule filing nowhere when it wasn’t started from a place', () => {
		stubPreview({ matched: 0, scanned: 0, total: 0 });
		editor({ rule: null });
		expect(fileItIn()).toBe('none');
	});

	it('keeps an existing rule’s own target, whatever it was opened from', () => {
		stubPreview({ matched: 0, scanned: 0, total: 0 });
		editor({ rule: saved, initialTarget: { kind: 'label', mailboxId: 'WORK' } });
		expect(fileItIn()).toBe('folder:RCPT');
	});

	it('says why it can’t count yet when the conditions don’t hold up', async () => {
		stubPreview({
			matched: 0,
			scanned: 0,
			total: 0,
			problems: [
				{ field: 'name', message: 'Give the rule a name.' },
				{ field: 'conditions', message: 'Give at least one condition something to match.' }
			]
		});
		editor({ rule: null });
		await waitFor(() => expect(screen.getByText('Not counted yet: Give at least one condition something to match.')).toBeTruthy(), {
			timeout: 2000
		});
		// The name is checked on Save, beside its field, not while typing.
		expect(screen.queryByText(/Give the rule a name/)).toBeNull();
		expect(screen.queryByText(/messages? match/)).toBeNull();
	});

	it('counts as before when only the name or target is missing', async () => {
		stubPreview({ matched: 4, scanned: 40, total: 40, problems: [{ field: 'name', message: 'Give the rule a name.' }] });
		editor({ rule: null });
		await waitFor(() => expect(screen.getByText(/Inbox messages match this rule/)).toBeTruthy(), { timeout: 2000 });
		expect(screen.getByText('4')).toBeTruthy();
		expect(screen.queryByText(/Not counted yet/)).toBeNull();
	});
});
