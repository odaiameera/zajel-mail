import { describe, expect, it } from 'vitest';
import type { Mailbox } from '$lib/jmap/types';
import { canMoveInto, folderOptions, mailboxKind, nextMailboxIds } from './mailboxes';

function box(id: string, name: string, extra: Partial<Mailbox> = {}): Mailbox {
	return { id, name, role: null, sortOrder: 0, totalEmails: 0, unreadEmails: 0, parentId: null, ...extra };
}

const MAILBOXES: Mailbox[] = [
	box('IN', 'Inbox', { role: 'inbox' }),
	box('AR', 'Archive', { role: 'archive' }),
	box('JK', 'Junk', { role: 'junk' }),
	box('TR', 'Trash', { role: 'trash' }),
	box('DR', 'Drafts', { role: 'drafts' }),
	box('SN', 'Sent', { role: 'sent' }),
	box('RML', 'Remind Me Later'),
	box('SCH', 'Scheduled'),
	box('LBLS', 'Labels'),
	box('WORK', 'Work', { parentId: 'LBLS' }),
	box('HOME', 'Home', { parentId: 'LBLS' }),
	box('WSUB', 'Under a label', { parentId: 'WORK' }),
	box('PRJ', 'Projects'),
	box('ZAJ', 'Zajel', { parentId: 'PRJ' }),
	box('PSCH', 'Scheduled', { parentId: 'PRJ' }),
	box('B', 'Bills')
];
const byId = (id: string) => MAILBOXES.find((m) => m.id === id)!;
const kind = (id: string, list = MAILBOXES) => mailboxKind(list.find((m) => m.id === id)!, list);

describe('mailboxKind', () => {
	it('names each kind of mailbox', () => {
		expect(['IN', 'AR', 'JK', 'TR', 'DR', 'SN'].map((id) => kind(id))).toEqual(Array(6).fill('system'));
		expect(kind('RML')).toBe('special');
		expect(kind('SCH')).toBe('special');
		expect(kind('LBLS')).toBe('labels-root');
		expect(kind('WORK')).toBe('label');
		expect(kind('HOME')).toBe('label');
		expect(kind('PRJ')).toBe('folder');
		expect(kind('ZAJ')).toBe('folder');
	});

	it('counts a mailbox under a label as a folder: only direct children of Labels are labels', () => {
		expect(kind('WSUB')).toBe('folder');
	});

	it('takes a top-level folder called Scheduled for the app’s own, but not one nested in a folder', () => {
		expect(kind('SCH')).toBe('special');
		expect(kind('PSCH')).toBe('folder');
		// A server that marks it with the role.
		expect(mailboxKind(box('S2', 'Outbox', { role: 'scheduled' }), MAILBOXES)).toBe('special');
	});

	it('has no labels on an account with no Labels mailbox', () => {
		const list = [box('IN', 'Inbox', { role: 'inbox' }), box('WORK', 'Work', { parentId: 'X' }), box('X', 'Things')];
		expect(kind('WORK', list)).toBe('folder');
		expect(kind('X', list)).toBe('folder');
	});
});

describe('canMoveInto', () => {
	it('allows a folder, the Inbox, Archive, Junk and Trash', () => {
		for (const id of ['PRJ', 'ZAJ', 'B', 'WSUB', 'IN', 'AR', 'JK', 'TR']) expect(canMoveInto(byId(id), MAILBOXES)).toBe(true);
	});

	it('refuses labels, the Labels container, Remind Me Later, Scheduled, Drafts and Sent', () => {
		for (const id of ['WORK', 'HOME', 'LBLS', 'RML', 'SCH', 'DR', 'SN']) expect(canMoveInto(byId(id), MAILBOXES)).toBe(false);
	});
});

describe('nextMailboxIds', () => {
	it('moves a message from one folder to another', () => {
		expect(nextMailboxIds({ IN: true }, { move: 'PRJ' }, MAILBOXES)).toEqual({ PRJ: true });
	});

	it('takes a message that was in two folders out of both', () => {
		expect(nextMailboxIds({ IN: true, B: true }, { move: 'PRJ' }, MAILBOXES)).toEqual({ PRJ: true });
	});

	it('keeps every label on a move', () => {
		expect(nextMailboxIds({ IN: true, WORK: true, HOME: true }, { move: 'AR' }, MAILBOXES)).toEqual({ AR: true, WORK: true, HOME: true });
	});

	it('gives a message that was only in labels a folder', () => {
		expect(nextMailboxIds({ WORK: true }, { move: 'PRJ' }, MAILBOXES)).toEqual({ PRJ: true, WORK: true });
	});

	it('adds a label and changes nothing else', () => {
		expect(nextMailboxIds({ IN: true, B: true }, { addLabel: 'WORK' }, MAILBOXES)).toEqual({ IN: true, B: true, WORK: true });
	});

	it('removes a label and leaves the folders alone', () => {
		expect(nextMailboxIds({ IN: true, WORK: true }, { removeLabel: 'WORK', archiveId: 'AR' }, MAILBOXES)).toEqual({ IN: true });
	});

	it('sends a message to Archive when its only label comes off, or asks for Archive when there is none', () => {
		expect(nextMailboxIds({ WORK: true }, { removeLabel: 'WORK', archiveId: 'AR' }, MAILBOXES)).toEqual({ AR: true });
		expect(nextMailboxIds({ WORK: true }, { removeLabel: 'WORK', archiveId: null }, MAILBOXES)).toBeNull();
	});

	it('changes nothing when the label isn’t on the message', () => {
		expect(nextMailboxIds({ IN: true }, { removeLabel: 'WORK', archiveId: 'AR' }, MAILBOXES)).toEqual({ IN: true });
	});
});

describe('folderOptions', () => {
	it('lists the folder tree, indented, without system folders, labels or the app’s own', () => {
		expect(folderOptions(MAILBOXES)).toEqual([
			{ id: 'B', name: 'Bills', depth: 0 },
			{ id: 'PRJ', name: 'Projects', depth: 0 },
			{ id: 'PSCH', name: 'Scheduled', depth: 1 },
			{ id: 'ZAJ', name: 'Zajel', depth: 1 },
			{ id: 'WSUB', name: 'Under a label', depth: 0 }
		]);
	});
});
