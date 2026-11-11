import { describe, expect, it } from 'vitest';
import { parseRule } from './schema';

const mailboxes = [
	{ id: 'IN', name: 'Inbox', role: 'inbox', parentId: null },
	{ id: 'TR', name: 'Trash', role: 'trash', parentId: null },
	{ id: 'AR', name: 'Archive', role: 'archive', parentId: null },
	{ id: 'RCPT', name: 'Receipts', role: null, parentId: null },
	{ id: 'LBLS', name: 'Labels', role: null, parentId: null },
	{ id: 'WORK', name: 'Work', role: null, parentId: 'LBLS' },
	{ id: 'RML', name: 'Remind Me Later', role: null, parentId: null },
	{ id: 'SCH', name: 'Scheduled', role: null, parentId: null }
];

const from = (value = 'shop.example', over: Record<string, unknown> = {}) => ({
	id: 'c1',
	field: 'from',
	op: 'contains',
	value,
	negate: false,
	...over
});

const draft = (over: Record<string, unknown> = {}) => ({
	name: 'Receipts',
	enabled: true,
	logic: 'allof',
	conditions: [from()],
	target: { kind: 'folder', mailboxId: 'RCPT' },
	markRead: false,
	star: false,
	stop: false,
	...over
});

const problems = (over: Record<string, unknown>, boxes = mailboxes) => parseRule(draft(over), boxes).problems;

describe('parseRule', () => {
	it('takes a good rule as it is', () => {
		expect(parseRule(draft(), mailboxes)).toEqual({ rule: draft(), problems: [] });
	});

	it('wants a name of 1 to 120 characters', () => {
		expect(problems({ name: '  ' })).toEqual([{ field: 'name', message: 'Give the rule a name.' }]);
		expect(problems({ name: 'x'.repeat(121) })).toEqual([
			{ field: 'name', message: 'Keep the name to 120 characters or fewer.' }
		]);
		expect(problems({ name: 'x'.repeat(120) })).toEqual([]);
	});

	it('wants all or any', () => {
		expect(problems({ logic: 'most' })).toEqual([{ field: 'logic', message: 'Match all or any of the conditions.' }]);
	});

	it('wants 1 to 20 conditions', () => {
		expect(problems({ conditions: [] })).toEqual([
			{ field: 'conditions', message: 'Add a condition: what mail should this rule act on?' }
		]);
		expect(problems({ conditions: Array.from({ length: 21 }, () => from()) })).toEqual([
			{ field: 'conditions', message: 'A rule can have at most 20 conditions.' }
		]);
	});

	it('knows each condition’s field and operator, and says which condition is wrong', () => {
		expect(problems({ conditions: [from(), from('x', { field: 'jev' })] })).toEqual([
			{ field: 'conditions', index: 1, message: 'Pick what this condition looks at.' }
		]);
		expect(problems({ conditions: [from('x', { op: 'sounds_like' })] })).toEqual([
			{ field: 'conditions', index: 0, message: 'Pick how this condition matches.' }
		]);
	});

	it('keeps values to 500 characters, and a size to a number', () => {
		expect(problems({ conditions: [from('x'.repeat(501))] })).toEqual([
			{ field: 'conditions', index: 0, message: 'Keep this to 500 characters or fewer.' }
		]);
		expect(problems({ conditions: [from('big', { field: 'size' })] })).toEqual([
			{ field: 'conditions', index: 0, message: 'Give the size as a whole number of KB.' }
		]);
		expect(parseRule(draft({ conditions: [from(' 200 ', { field: 'size' })] }), mailboxes).rule.conditions[0].value).toBe('200');
	});

	it('wants one condition with something to match, and drops empty ones', () => {
		expect(problems({ conditions: [from(''), from('  ')] })).toEqual([
			{ field: 'conditions', message: 'Give at least one condition something to match.' }
		]);
		const { rule } = parseRule(draft({ conditions: [from(''), from('shop', { id: 'c2' })] }), mailboxes);
		expect(rule.conditions.map((c) => c.id)).toEqual(['c2']);
	});

	it('files only into a folder or label that exists, of the kind it says', () => {
		expect(problems({ target: { kind: 'folder', mailboxId: 'GONE' } })).toEqual([
			{ field: 'target', message: 'Pick a folder: the one chosen no longer exists.' }
		]);
		// A label given as a folder, and a folder given as a label.
		expect(problems({ target: { kind: 'folder', mailboxId: 'WORK' } })).toEqual([
			{ field: 'target', message: '“Work” is a label, not a folder.' }
		]);
		expect(problems({ target: { kind: 'label', mailboxId: 'RCPT' } })).toEqual([
			{ field: 'target', message: '“Receipts” is a folder, not a label.' }
		]);
		expect(parseRule(draft({ target: { kind: 'label', mailboxId: 'WORK' } }), mailboxes).problems).toEqual([]);
	});

	it('never files into the Labels container, Remind Me Later, Scheduled or the Inbox', () => {
		expect(problems({ target: { kind: 'folder', mailboxId: 'LBLS' } })).toEqual([
			{ field: 'target', message: '“Labels” holds your labels: pick a folder or a label.' }
		]);
		expect(problems({ target: { kind: 'label', mailboxId: 'LBLS' } })).toEqual([
			{ field: 'target', message: '“Labels” is a folder, not a label.' }
		]);
		expect(problems({ target: { kind: 'folder', mailboxId: 'RML' } })).toEqual([
			{ field: 'target', message: 'Rules can’t file mail into “Remind Me Later”.' }
		]);
		expect(problems({ target: { kind: 'folder', mailboxId: 'SCH' } })).toEqual([
			{ field: 'target', message: 'Rules can’t file mail into “Scheduled”.' }
		]);
		expect(problems({ target: { kind: 'folder', mailboxId: 'IN' } })).toEqual([
			{ field: 'target', message: 'Rules can’t file mail into “Inbox”.' }
		]);
	});

	it('files into Trash, Archive or Junk only where the account has one, and names them by role', () => {
		expect(problems({ target: { kind: 'junk' } })).toEqual([{ field: 'target', message: 'This account has no Junk folder.' }]);
		expect(parseRule(draft({ target: { kind: 'trash' } }), mailboxes).rule.target).toEqual({ kind: 'trash' });
		// Archive picked as a folder is Archive.
		expect(parseRule(draft({ target: { kind: 'folder', mailboxId: 'AR' } }), mailboxes).rule.target).toEqual({ kind: 'archive' });
	});

	it('wants the rule to do something, stopping later rules included', () => {
		const message = 'Give the rule something to do: a place to file mail, mark as read, star, or stop later rules.';
		expect(problems({ target: { kind: 'none' } })).toEqual([{ field: 'actions', message }]);
		expect(problems({ target: { kind: 'none' }, stop: true })).toEqual([]);
		expect(problems({ target: { kind: 'none' }, markRead: true })).toEqual([]);
		expect(problems({ target: { kind: 'none' }, star: true })).toEqual([]);
	});

	it('drops fields it doesn’t know, and never takes the server’s own from a client', () => {
		const { rule, problems: found } = parseRule(
			draft({
				id: 'theirs',
				position: 0,
				attention: 'tab_removed',
				note: { splitInto: 2 },
				legacy: { enabled: true },
				actions: [{ type: 'delete' }],
				conditions: [from('shop.example', { strictness: 'strict' })]
			}),
			mailboxes
		);
		expect(found).toEqual([]);
		expect(rule).toEqual(draft());
		expect(Object.keys(rule.conditions[0]).sort()).toEqual(['field', 'id', 'negate', 'op', 'value']);
	});
});
