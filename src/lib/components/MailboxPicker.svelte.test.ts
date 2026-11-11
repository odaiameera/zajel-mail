// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import type { Mailbox } from '$lib/jmap/types';

vi.mock('$app/state', () => ({ page: { data: { mailboxMeta: {} } } }));

import MailboxPicker from './MailboxPicker.svelte';

function box(id: string, name: string, extra: Partial<Mailbox> = {}): Mailbox {
	return { id, name, role: null, sortOrder: 0, totalEmails: 0, unreadEmails: 0, parentId: null, ...extra };
}

const MAILBOXES: Mailbox[] = [
	box('TR', 'Trash', { role: 'trash' }),
	box('SN', 'Sent', { role: 'sent' }),
	box('DR', 'Drafts', { role: 'drafts' }),
	box('JK', 'Junk', { role: 'junk' }),
	box('AR', 'Archive', { role: 'archive' }),
	box('IN', 'Inbox', { role: 'inbox' }),
	box('RML', 'Remind Me Later'),
	box('SCH', 'Scheduled'),
	box('LBLS', 'Labels'),
	box('HOME', 'Home', { parentId: 'LBLS', sortOrder: 20 }),
	box('WORK', 'Work', { parentId: 'LBLS', sortOrder: 10 }),
	box('PRJ', 'Projects'),
	box('ZAJ', 'Zajel', { parentId: 'PRJ' }),
	box('B', 'Bills')
];

afterEach(cleanup);

function open(props: Partial<{ excludeIds: string[]; appliedLabelIds: string[] }> = {}) {
	const onMove = vi.fn();
	const onAddLabel = vi.fn();
	render(MailboxPicker, {
		props: {
			mailboxes: MAILBOXES,
			labels: [{ id: 'WORK', name: 'Work', color: '#ff0000' }],
			onMove,
			onAddLabel,
			onClose: vi.fn(),
			...props
		}
	});
	const rows = () =>
		[...document.querySelectorAll<HTMLButtonElement>('button[data-section]')].map((b) => ({
			name: b.textContent!.trim(),
			section: b.dataset.section,
			indent: b.style.paddingLeft
		}));
	return { onMove, onAddLabel, rows };
}

describe('MailboxPicker', () => {
	it('lists Inbox, Archive, Junk and Trash, then the folder tree, then the labels, each under its heading', () => {
		const { rows } = open();
		expect(rows().map((r) => [r.section, r.name])).toEqual([
			['move', 'Inbox'],
			['move', 'Archive'],
			['move', 'Junk'],
			['move', 'Trash'],
			['move', 'Bills'],
			['move', 'Projects'],
			['move', 'Zajel'],
			['label', 'Work'],
			['label', 'Home']
		]);
		expect(screen.getByText('Move to')).toBeTruthy();
		expect(screen.getByText('Label')).toBeTruthy();
	});

	it('indents a folder under its parent', () => {
		const { rows } = open();
		const indent = Object.fromEntries(rows().map((r) => [r.name, r.indent]));
		expect(indent.Projects).toBe('12px');
		expect(indent.Zajel).toBe('26px');
	});

	it('never offers Remind Me Later, Scheduled, Drafts, Sent or the Labels container', () => {
		const { rows } = open();
		const names = rows().map((r) => r.name);
		for (const name of ['Remind Me Later', 'Scheduled', 'Drafts', 'Sent', 'Labels']) expect(names).not.toContain(name);
	});

	it('leaves out the folder the message is in', () => {
		const { rows } = open({ excludeIds: ['IN'] });
		expect(rows().map((r) => r.name)).not.toContain('Inbox');
	});

	it('moves on a folder, and only adds a label on a label', async () => {
		const { onMove, onAddLabel } = open();
		await fireEvent.click(screen.getByRole('button', { name: /Projects/ }));
		expect(onMove).toHaveBeenCalledWith('PRJ');
		await fireEvent.click(screen.getByRole('button', { name: /Work/ }));
		expect(onAddLabel).toHaveBeenCalledWith('WORK');
		expect(onMove).toHaveBeenCalledTimes(1);
	});

	it('finds by name, across both sections', async () => {
		const { rows } = open();
		await fireEvent.input(screen.getByRole('textbox'), { target: { value: 'o' } });
		expect(rows().map((r) => r.name)).toEqual(['Inbox', 'Projects', 'Work', 'Home']);
	});
});
