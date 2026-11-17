import { describe, expect, it } from 'vitest';
import {
	actionIds,
	countedMembers,
	expandedByDefault,
	foldedRuns,
	participantLine,
	shortName,
	summariseThread,
	type ThreadMember,
	type ThreadScope
} from './threads';

const INBOX = 'in', SENT = 'sent', DRAFTS = 'drafts', TRASH = 'trash', JUNK = 'junk', LABEL = 'label';
const scope = (hereId: string | null): ThreadScope => ({ hereId, trashId: TRASH, junkId: JUNK, draftsId: DRAFTS });
const dana = { name: 'Dana Wade', email: 'dana@example.test' };
const sam = { name: 'Sam Okafor', email: 'sam@example.test' };
const me = { name: 'Odai', email: 'me@example.test' };

let clock = 0;
function msg(id: string, from: typeof dana, box: string | string[], keywords: string[] = ['$seen'], extra: Partial<ThreadMember> = {}): ThreadMember {
	return {
		id,
		threadId: 't',
		mailboxIds: Object.fromEntries((Array.isArray(box) ? box : [box]).map((b) => [b, true])),
		keywords: Object.fromEntries(keywords.map((k) => [k, true])),
		from: [from],
		receivedAt: `2026-11-16T10:${String(clock++).padStart(2, '0')}:00Z`,
		hasAttachment: false,
		...extra
	};
}

const thread = () => {
	clock = 0;
	return [
		msg('a', dana, INBOX),
		msg('b', me, SENT),
		msg('c', dana, [INBOX, LABEL], [], { hasAttachment: true }),
		msg('x', dana, TRASH),
		msg('d', sam, INBOX, ['$flagged']),
		msg('e', me, DRAFTS, ['$draft', '$seen'])
	];
};

describe('countedMembers', () => {
	it('counts everything not in Trash or Junk, wherever it is filed, oldest first', () => {
		expect(countedMembers(thread().reverse(), scope(INBOX)).map((m) => m.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
		expect(countedMembers(thread(), scope(null)).map((m) => m.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
	});

	it('counts only what is in the bin, in the Trash and Junk lists', () => {
		expect(countedMembers(thread(), scope(TRASH)).map((m) => m.id)).toEqual(['x']);
		expect(countedMembers(thread(), scope(JUNK))).toEqual([]);
	});
});

describe('summariseThread', () => {
	it('says what the row needs of the whole conversation', () => {
		const s = summariseThread('t', thread(), scope(INBOX));
		expect(s.ids).toEqual(['a', 'b', 'c', 'd', 'e']);
		expect(s.idsHere).toEqual(['a', 'c', 'd']);
		expect(s.unreadIds).toEqual(['c', 'd']);
		expect(s.flaggedIds).toEqual(['d']);
		// The newest that isn't the unsent draft.
		expect(s.latestId).toBe('d');
		expect(s.hasAttachment).toBe(true);
		expect(s.hasDraft).toBe(true);
		expect(Object.keys(s.mailboxIds).sort()).toEqual([DRAFTS, INBOX, LABEL, SENT].sort());
	});

	it('names each writer once, in order of first appearance, and who has something unread', () => {
		const s = summariseThread('t', thread(), scope(INBOX));
		expect(s.participants).toEqual([
			{ ...dana, unread: true },
			{ ...me, unread: false },
			{ ...sam, unread: true }
		]);
	});

	it('does not count a draft as unread, or its writer as having written', () => {
		clock = 0;
		const s = summariseThread('t', [msg('a', dana, INBOX), msg('e', me, DRAFTS, ['$draft'])], scope(INBOX));
		expect(s.unreadIds).toEqual([]);
		expect(s.participants.map((p) => p.email)).toEqual([dana.email]);
		expect(s.latestId).toBe('a');
	});

	it('takes every message as "here" in a list that is no mailbox', () => {
		expect(summariseThread('t', thread(), scope(null)).idsHere).toEqual(['a', 'b', 'c', 'd', 'e']);
	});
});

describe('participantLine', () => {
	const people = (n: number, unreadAt = -1) =>
		[dana, me, sam, { name: 'Lee Chen', email: 'lee@example.test' }, { name: null, email: 'ops@example.test' }]
			.slice(0, n)
			.map((p, i) => ({ ...p, unread: i === unreadAt }));

	it('names one writer in full, and you as "me"', () => {
		expect(participantLine(people(1), [])).toEqual([{ text: 'Dana Wade', unread: false }]);
		expect(participantLine([{ ...me, unread: false }], ['ME@example.test'])).toEqual([{ text: 'me', unread: false }]);
	});

	it('names several by first name, with who is unread', () => {
		expect(participantLine(people(3, 2), [me.email])).toEqual([
			{ text: 'Dana', unread: false },
			{ text: 'me', unread: false },
			{ text: 'Sam', unread: true }
		]);
	});

	it('keeps the first and the last two of a crowd', () => {
		expect(participantLine(people(5), [me.email]).map((p) => p.text)).toEqual(['Dana', '…', 'Lee', 'ops']);
	});

	it('falls back to the address when there is no name', () => {
		expect(shortName({ name: null, email: 'billing@example.test' })).toBe('billing');
		expect(shortName({ name: 'Wade, Dana', email: 'd@example.test' })).toBe('Wade');
	});
});

describe('actionIds', () => {
	const s = () => summariseThread('t', thread(), scope(INBOX));

	it('archives, moves and snoozes what is in this list, leaving your replies in Sent', () => {
		for (const action of ['archive', 'moveTo', 'spam', 'snooze', 'setCategory']) expect(actionIds(s(), action), action).toEqual(['a', 'c', 'd']);
	});

	it('trashes and labels the whole conversation', () => {
		expect(actionIds(s(), 'trash')).toEqual(['a', 'b', 'c', 'd', 'e']);
		expect(actionIds(s(), 'label')).toEqual(['a', 'b', 'c', 'd', 'e']);
	});

	it('marks every unread message read, and only the latest unread', () => {
		expect(actionIds(s(), 'markRead')).toEqual(['c', 'd']);
		expect(actionIds(s(), 'markUnread')).toEqual(['d']);
	});

	it('stars the latest message and clears every star', () => {
		expect(actionIds(s(), 'flag')).toEqual(['d']);
		expect(actionIds(s(), 'unflag')).toEqual(['d']);
	});

	it('falls back to the whole conversation when none of it is in this list', () => {
		expect(actionIds(summariseThread('t', thread(), scope('elsewhere')), 'archive')).toEqual(['a', 'b', 'c', 'd', 'e']);
	});
});

describe('expandedByDefault', () => {
	const m = (id: string, ...keywords: string[]) => ({ id, keywords: Object.fromEntries(keywords.map((k) => [k, true])) });

	it('opens the unread ones and the last', () => {
		expect([...expandedByDefault([m('a', '$seen'), m('b'), m('c', '$seen'), m('d', '$seen')], null)].sort()).toEqual(['b', 'd']);
	});

	it('opens the one asked for, and a draft', () => {
		expect([...expandedByDefault([m('a', '$seen'), m('b', '$seen'), m('c', '$seen', '$draft'), m('d', '$seen')], 'a')].sort()).toEqual(['a', 'c', 'd']);
		expect([...expandedByDefault([m('a', '$seen')], 'gone')]).toEqual(['a']);
	});
});

describe('foldedRuns', () => {
	const list = (n: number) => Array.from({ length: n }, (_, i) => ({ id: String(i) }));

	it('folds the middle of a long run of collapsed messages, keeping its first and last in view', () => {
		expect(foldedRuns(list(9), new Set(['8']))).toEqual([[1, 7]]);
		expect(foldedRuns(list(10), new Set(['4', '9']))).toEqual([[1, 3], [6, 8]]);
	});

	it('leaves a short run alone', () => {
		expect(foldedRuns(list(4), new Set(['3']))).toEqual([]);
		expect(foldedRuns(list(3), new Set())).toEqual([]);
	});
});
