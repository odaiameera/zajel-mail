import { describe, expect, it } from 'vitest';
import type { Mailbox } from '$lib/jmap/types';
import {
	buildFolderTree,
	filterUserFolders,
	flattenFolderTree,
	moveStep,
	orderedSiblings,
	planReorder
} from './folder-tree';

function box(
	id: string,
	name: string,
	extra: Partial<Mailbox> = {}
): Mailbox {
	return { id, name, role: null, sortOrder: 0, totalEmails: 0, unreadEmails: 0, parentId: null, ...extra };
}

// A typical account: system folders, two app folders, a Labels container
// with two labels, and three user folders of which one is nested.
const MAILBOXES: Mailbox[] = [
	box('IN', 'Inbox', { role: 'inbox' }),
	box('TR', 'Trash', { role: 'trash' }),
	box('RML', 'Remind Me Later'),
	box('SCH', 'Scheduled'),
	box('LBLS', 'Labels'),
	box('WORK', 'Work', { parentId: 'LBLS' }),
	box('HOME', 'Home', { parentId: 'LBLS' }),
	box('B', 'Bills'),
	box('A', 'Archive 2025'),
	box('P', 'Projects'),
	box('P1', 'Zajel', { parentId: 'P' })
];

describe('filterUserFolders', () => {
	it('keeps only the folders the user may rearrange', () => {
		expect(filterUserFolders(MAILBOXES).map((m) => m.id).sort()).toEqual(['A', 'B', 'P', 'P1']);
	});
});

describe('buildFolderTree', () => {
	it('reads alphabetically while nothing has been placed', () => {
		expect(flattenFolderTree(buildFolderTree(MAILBOXES)).map((o) => o.name)).toEqual([
			'Archive 2025',
			'Bills',
			'Projects',
			'Zajel'
		]);
	});

	it('follows sortOrder once it is set, falling back to the name', () => {
		const placed = MAILBOXES.map((m) => (m.id === 'P' ? { ...m, sortOrder: 10 } : m.id === 'B' ? { ...m, sortOrder: 20 } : m));
		expect(flattenFolderTree(buildFolderTree(placed)).map((o) => o.id)).toEqual(['A', 'P', 'P1', 'B']);
	});
});

describe('planReorder', () => {
	it('renumbers the level with the moved folder before the one it was dropped on', () => {
		const plan = planReorder(MAILBOXES, { id: 'P', parentId: null, beforeId: 'A' });
		expect(plan).toEqual({
			P: { parentId: null, sortOrder: 10 },
			A: { parentId: null, sortOrder: 20 },
			B: { parentId: null, sortOrder: 30 }
		});
	});

	it('puts a folder last when there is nothing to go before', () => {
		const plan = planReorder(MAILBOXES, { id: 'A', parentId: null, beforeId: null });
		expect(plan).toEqual({
			B: { parentId: null, sortOrder: 10 },
			P: { parentId: null, sortOrder: 20 },
			A: { parentId: null, sortOrder: 30 }
		});
	});

	it('nests a folder under another, after its existing children', () => {
		const plan = planReorder(MAILBOXES, { id: 'B', parentId: 'P', beforeId: null });
		expect(plan).toEqual({
			P1: { parentId: 'P', sortOrder: 10 },
			B: { parentId: 'P', sortOrder: 20 }
		});
	});

	it('leaves out mailboxes that already sit where they would be put', () => {
		const placed = MAILBOXES.map((m) =>
			m.id === 'A' ? { ...m, sortOrder: 10 } : m.id === 'B' ? { ...m, sortOrder: 20 } : m.id === 'P' ? { ...m, sortOrder: 30 } : m
		);
		expect(planReorder(placed, { id: 'P', parentId: null, beforeId: null })).toEqual({});
	});

	it('reorders labels among labels only', () => {
		expect(planReorder(MAILBOXES, { id: 'WORK', parentId: 'LBLS', beforeId: 'HOME' })).toEqual({
			WORK: { parentId: 'LBLS', sortOrder: 10 },
			HOME: { parentId: 'LBLS', sortOrder: 20 }
		});
		expect(planReorder(MAILBOXES, { id: 'WORK', parentId: null, beforeId: null })).toEqual({
			error: 'Labels stay under Labels'
		});
		expect(planReorder(MAILBOXES, { id: 'B', parentId: 'LBLS', beforeId: null })).toEqual({
			error: 'Folders cannot go among the labels'
		});
	});

	it('refuses a drop target that is not at the destination level', () => {
		expect(planReorder(MAILBOXES, { id: 'B', parentId: 'P', beforeId: 'A' })).toEqual({
			error: 'That folder is not at the destination'
		});
		expect(planReorder(MAILBOXES, { id: 'nope', parentId: null, beforeId: null })).toEqual({
			error: 'Folder not found'
		});
	});

	it('never renumbers the system folders, Remind Me Later or Scheduled', () => {
		const plan = planReorder(MAILBOXES, { id: 'A', parentId: null, beforeId: null });
		expect(Object.keys(plan)).not.toContain('IN');
		expect(Object.keys(plan)).not.toContain('RML');
		expect(Object.keys(plan)).not.toContain('SCH');
		expect(orderedSiblings(MAILBOXES, null, false).map((m) => m.id)).toEqual(['A', 'B', 'P']);
	});
});

describe('moveStep', () => {
	it('moves one place up or down and stops at the ends', () => {
		expect(moveStep(MAILBOXES, 'B', 'up')).toEqual({ id: 'B', parentId: null, beforeId: 'A' });
		expect(moveStep(MAILBOXES, 'B', 'down')).toEqual({ id: 'B', parentId: null, beforeId: null });
		expect(moveStep(MAILBOXES, 'A', 'up')).toBeNull();
		expect(moveStep(MAILBOXES, 'P', 'down')).toBeNull();
		// Down past the middle: before the one after the next.
		expect(moveStep(MAILBOXES, 'A', 'down')).toEqual({ id: 'A', parentId: null, beforeId: 'P' });
	});

	it('keeps labels under the Labels container', () => {
		expect(moveStep(MAILBOXES, 'WORK', 'up')).toEqual({ id: 'WORK', parentId: 'LBLS', beforeId: 'HOME' });
		expect(moveStep(MAILBOXES, 'HOME', 'up')).toBeNull();
	});
});
