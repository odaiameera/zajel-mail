import { describe, expect, it } from 'vitest';
import type { Mailbox } from '$lib/jmap/types';
import {
	buildFolderTree,
	canDropMailbox,
	dropRequest,
	filterUserFolders,
	flattenFolderTree,
	moveStep,
	orderedSiblings,
	planReorder,
	type DropWhere
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

// The same account with a folder two levels down and a third label, so
// "after" has something to go before. Shown: Archive 2025, Bills, Projects
// (Zajel (Notes)); Home, Trips, Work.
const DEEPER: Mailbox[] = [...MAILBOXES, box('P2', 'Notes', { parentId: 'P1' }), box('TRIPS', 'Trips', { parentId: 'LBLS' })];
const ZONES: DropWhere[] = ['before', 'after', 'into'];

describe('canDropMailbox', () => {
	it('lets a folder land on another folder, at any level', () => {
		expect(canDropMailbox(DEEPER, 'B', 'A')).toBe(true);
		expect(canDropMailbox(DEEPER, 'B', 'P1')).toBe(true);
		expect(canDropMailbox(DEEPER, 'B', 'P2')).toBe(true);
		// Out of its parent, or onto it.
		expect(canDropMailbox(DEEPER, 'P1', 'A')).toBe(true);
		expect(canDropMailbox(DEEPER, 'P1', 'P')).toBe(true);
		expect(canDropMailbox(DEEPER, 'P2', 'P')).toBe(true);
	});

	it('lets a label land on another label', () => {
		expect(canDropMailbox(DEEPER, 'WORK', 'HOME')).toBe(true);
		expect(canDropMailbox(DEEPER, 'HOME', 'TRIPS')).toBe(true);
	});

	it('keeps folders and labels apart', () => {
		expect(canDropMailbox(DEEPER, 'B', 'WORK')).toBe(false);
		expect(canDropMailbox(DEEPER, 'P1', 'HOME')).toBe(false);
		expect(canDropMailbox(DEEPER, 'WORK', 'B')).toBe(false);
		expect(canDropMailbox(DEEPER, 'HOME', 'P1')).toBe(false);
	});

	it('lands nothing on itself', () => {
		expect(canDropMailbox(DEEPER, 'B', 'B')).toBe(false);
		expect(canDropMailbox(DEEPER, 'P1', 'P1')).toBe(false);
		expect(canDropMailbox(DEEPER, 'WORK', 'WORK')).toBe(false);
	});

	it('keeps a folder out of its own children, however deep', () => {
		expect(canDropMailbox(DEEPER, 'P', 'P1')).toBe(false);
		expect(canDropMailbox(DEEPER, 'P', 'P2')).toBe(false);
		expect(canDropMailbox(DEEPER, 'P1', 'P2')).toBe(false);
	});

	it('refuses a mailbox it does not know', () => {
		expect(canDropMailbox(DEEPER, 'nope', 'B')).toBe(false);
		expect(canDropMailbox(DEEPER, 'B', 'nope')).toBe(false);
	});
});

describe('dropRequest', () => {
	it('puts a folder before the one it was dropped on', () => {
		expect(dropRequest(DEEPER, 'P', 'A', 'before')).toEqual({ id: 'P', parentId: null, beforeId: 'A' });
		expect(dropRequest(DEEPER, 'P', 'B', 'before')).toEqual({ id: 'P', parentId: null, beforeId: 'B' });
	});

	it('puts a folder after the one it was dropped on: before the next, or last', () => {
		expect(dropRequest(DEEPER, 'P', 'A', 'after')).toEqual({ id: 'P', parentId: null, beforeId: 'B' });
		expect(dropRequest(DEEPER, 'A', 'B', 'after')).toEqual({ id: 'A', parentId: null, beforeId: 'P' });
		expect(dropRequest(DEEPER, 'A', 'P', 'after')).toEqual({ id: 'A', parentId: null, beforeId: null });
	});

	it('leaves the dragged folder out when looking for what comes next', () => {
		// Bills after Archive, where Bills already is: before Projects, not before itself.
		expect(dropRequest(DEEPER, 'B', 'A', 'after')).toEqual({ id: 'B', parentId: null, beforeId: 'P' });
	});

	it('puts a folder inside the one it was dropped into, last', () => {
		expect(dropRequest(DEEPER, 'B', 'P', 'into')).toEqual({ id: 'B', parentId: 'P', beforeId: null });
		expect(dropRequest(DEEPER, 'B', 'A', 'into')).toEqual({ id: 'B', parentId: 'A', beforeId: null });
		expect(dropRequest(DEEPER, 'B', 'P2', 'into')).toEqual({ id: 'B', parentId: 'P2', beforeId: null });
	});

	it('joins the level of a nested folder it is dropped beside', () => {
		expect(dropRequest(DEEPER, 'B', 'P1', 'before')).toEqual({ id: 'B', parentId: 'P', beforeId: 'P1' });
		expect(dropRequest(DEEPER, 'B', 'P1', 'after')).toEqual({ id: 'B', parentId: 'P', beforeId: null });
		expect(dropRequest(DEEPER, 'A', 'P2', 'before')).toEqual({ id: 'A', parentId: 'P1', beforeId: 'P2' });
	});

	it('takes a nested folder out to the level of the folder it is dropped beside', () => {
		expect(dropRequest(DEEPER, 'P1', 'B', 'before')).toEqual({ id: 'P1', parentId: null, beforeId: 'B' });
		expect(dropRequest(DEEPER, 'P2', 'P', 'after')).toEqual({ id: 'P2', parentId: null, beforeId: null });
		// Onto its own parent's middle: still inside it, last.
		expect(dropRequest(DEEPER, 'P1', 'P', 'into')).toEqual({ id: 'P1', parentId: 'P', beforeId: null });
	});

	it('puts a label before or after another, under the Labels container', () => {
		expect(dropRequest(DEEPER, 'WORK', 'HOME', 'before')).toEqual({ id: 'WORK', parentId: 'LBLS', beforeId: 'HOME' });
		expect(dropRequest(DEEPER, 'WORK', 'HOME', 'after')).toEqual({ id: 'WORK', parentId: 'LBLS', beforeId: 'TRIPS' });
		expect(dropRequest(DEEPER, 'HOME', 'WORK', 'after')).toEqual({ id: 'HOME', parentId: 'LBLS', beforeId: null });
	});

	it('counts "into" a label as after it: a label has no inside', () => {
		expect(dropRequest(DEEPER, 'WORK', 'HOME', 'into')).toEqual({ id: 'WORK', parentId: 'LBLS', beforeId: 'TRIPS' });
		expect(dropRequest(DEEPER, 'HOME', 'WORK', 'into')).toEqual({ id: 'HOME', parentId: 'LBLS', beforeId: null });
		for (const [drag, target] of [
			['WORK', 'HOME'],
			['HOME', 'WORK'],
			['TRIPS', 'HOME']
		]) {
			expect(dropRequest(DEEPER, drag, target, 'into')).toEqual(dropRequest(DEEPER, drag, target, 'after'));
		}
	});

	it('refuses a folder onto a label and a label onto a folder, wherever on it', () => {
		for (const where of ZONES) {
			expect(dropRequest(DEEPER, 'B', 'WORK', where)).toBeNull();
			expect(dropRequest(DEEPER, 'WORK', 'B', where)).toBeNull();
		}
	});

	it('refuses a mailbox onto itself', () => {
		for (const where of ZONES) {
			expect(dropRequest(DEEPER, 'B', 'B', where)).toBeNull();
			expect(dropRequest(DEEPER, 'WORK', 'WORK', where)).toBeNull();
		}
	});

	it('refuses a folder into, or beside, one of its own children', () => {
		for (const where of ZONES) {
			expect(dropRequest(DEEPER, 'P', 'P1', where)).toBeNull();
			expect(dropRequest(DEEPER, 'P', 'P2', where)).toBeNull();
			expect(dropRequest(DEEPER, 'P1', 'P2', where)).toBeNull();
		}
	});

	it('refuses a mailbox it does not know', () => {
		expect(dropRequest(DEEPER, 'nope', 'B', 'before')).toBeNull();
		expect(dropRequest(DEEPER, 'B', 'nope', 'into')).toBeNull();
	});

	it('asks only for what planReorder accepts', () => {
		const ids = ['A', 'B', 'P', 'P1', 'P2', 'HOME', 'TRIPS', 'WORK'];
		let asked = 0;
		for (const drag of ids) {
			for (const target of ids) {
				for (const where of ZONES) {
					const request = dropRequest(DEEPER, drag, target, where);
					if (!request) continue;
					asked++;
					expect(planReorder(DEEPER, request), `${drag} ${where} ${target}`).not.toHaveProperty('error');
				}
			}
		}
		expect(asked).toBeGreaterThan(0);
	});

	it('does not change the mailboxes it was given', () => {
		const before = structuredClone(DEEPER);
		dropRequest(DEEPER, 'P', 'A', 'before');
		dropRequest(DEEPER, 'WORK', 'HOME', 'after');
		expect(DEEPER).toEqual(before);
	});
});
