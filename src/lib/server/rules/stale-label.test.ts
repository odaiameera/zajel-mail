import { describe, expect, it } from 'vitest';
import { emptyOutcome, outcomeToUpdate } from './engine';

/**
 * A move worked out with a mailbox list loaded before a label existed. The
 * Jev worker and the rules scheduler load the list once per pass; a label
 * made meanwhile, and put on a message, is not in it. An id the list
 * doesn't know is kept, never treated as a folder to leave.
 */
describe('a move with a mailbox list older than a label', () => {
	const staleList = [
		{ id: 'IN', name: 'Inbox', role: 'inbox', parentId: null },
		{ id: 'JK', name: 'Junk', role: 'junk', parentId: null },
		{ id: 'LBLS', name: 'Labels', role: null, parentId: null },
		{ id: 'WORK', name: 'Work', role: null, parentId: 'LBLS' },
		{ id: 'B', name: 'Bills', role: null, parentId: null }
		// NEWLBL (a child of LBLS) was made after this list was loaded.
	];

	it('keeps the label the list doesn’t know', () => {
		const current = { mailboxIds: { IN: true, WORK: true, NEWLBL: true }, keywords: {} };
		const outcome = emptyOutcome();
		outcome.moveTo = 'JK';
		expect(outcomeToUpdate(current, outcome, staleList).mailboxIds).toEqual({ JK: true, WORK: true, NEWLBL: true });
	});

	it('still takes a message in two known folders out of both', () => {
		// A4: nothing changes when every id is known.
		const current = { mailboxIds: { IN: true, B: true, WORK: true }, keywords: {} };
		const outcome = emptyOutcome();
		outcome.moveTo = 'JK';
		expect(outcomeToUpdate(current, outcome, staleList).mailboxIds).toEqual({ JK: true, WORK: true });
	});
});
