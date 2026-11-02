import { describe, expect, it } from 'vitest';
import { buildJmapFilter } from '$lib/search/build-filter';
import { parseSearch } from '$lib/search/parse';
import { indexPrefilter, matchesFilter, splitSemantic } from './filter';
import { fakeEmail } from './__fixtures__/fakes';

const ctx = { mailboxesByRole: { inbox: 'IN', archive: 'AR' }, labelsByName: { bills: 'L1' }, foldersByName: {} };
const fromSearchBox = (raw: string) => buildJmapFilter(parseSearch(raw), ctx);

describe('splitSemantic', () => {
	it('takes the free text from a search-box query and keeps the operators', () => {
		expect(splitSemantic(fromSearchBox('plumber quote in:archive is:unread'))).toEqual({
			text: 'plumber quote',
			rest: { operator: 'AND', conditions: [{ inMailbox: 'AR' }, { notKeyword: '$seen' }] }
		});
		expect(splitSemantic(fromSearchBox('flight'))).toEqual({ text: 'flight', rest: null });
	});

	it('handles a text condition with other keys in the same object', () => {
		expect(splitSemantic({ text: 'invoice', from: 'acme' })).toEqual({ text: 'invoice', rest: { from: 'acme' } });
	});

	it('has nothing to ask the vectors without free text', () => {
		expect(splitSemantic(fromSearchBox('from:sam is:starred'))).toBeNull();
		expect(splitSemantic(null)).toBeNull();
	});

	it('leaves text under OR or NOT, and conditions it can’t check, to keywords alone', () => {
		expect(splitSemantic({ operator: 'OR', conditions: [{ text: 'a' }, { from: 'b' }] })).toBeNull();
		expect(splitSemantic({ operator: 'AND', conditions: [{ text: 'a' }, { operator: 'NOT', conditions: [{ text: 'b' }] }] })).toBeNull();
		expect(splitSemantic(fromSearchBox('quote body:"kitchen"'))).toBeNull();
	});
});

describe('matchesFilter', () => {
	const email = fakeEmail({
		id: 'x',
		receivedAt: '2026-04-10T08:00:00Z',
		subject: 'Kitchen sink quote',
		from: 'Sam@Plumb.example',
		mailboxIds: ['AR', 'L1'],
		keywords: { $flagged: true }
	});

	it('checks what the search box and the agent can ask for', () => {
		expect(matchesFilter(email, fromSearchBox('in:archive label:bills from:plumb is:unread is:starred subject:sink after:2026-04-01 before:2026-04-10'))).toBe(true);
		expect(matchesFilter(email, fromSearchBox('in:inbox'))).toBe(false);
		expect(matchesFilter(email, fromSearchBox('is:read'))).toBe(false);
		expect(matchesFilter(email, fromSearchBox('before:2026-04-09'))).toBe(false);
		expect(matchesFilter(email, fromSearchBox('has:attachment'))).toBe(false);
		expect(matchesFilter(email, fromSearchBox('label:nope'))).toBe(false);
	});

	it('follows AND, OR and NOT', () => {
		expect(matchesFilter(email, { operator: 'OR', conditions: [{ inMailbox: 'IN' }, { inMailbox: 'AR' }] })).toBe(true);
		expect(matchesFilter(email, { operator: 'NOT', conditions: [{ inMailbox: 'AR' }] })).toBe(false);
		expect(matchesFilter(email, null)).toBe(true);
	});
});

describe('indexPrefilter', () => {
	it('applies top-level mailbox and date conditions to what the index stores', () => {
		const allow = indexPrefilter({
			operator: 'AND',
			conditions: [{ inMailbox: 'AR' }, { after: '2026-01-01T00:00:00Z' }, { before: '2026-02-01T00:00:00Z' }, { from: 'sam' }]
		});
		const at = (iso: string) => Date.parse(iso);
		expect(allow({ id: 'a', receivedAt: at('2026-01-15T00:00:00Z'), mailboxIds: ['AR'] })).toBe(true);
		expect(allow({ id: 'b', receivedAt: at('2026-01-15T00:00:00Z'), mailboxIds: ['IN'] })).toBe(false);
		expect(allow({ id: 'c', receivedAt: at('2026-02-01T00:00:00Z'), mailboxIds: ['AR'] })).toBe(false);
		expect(indexPrefilter(null)({ id: 'd', receivedAt: 0, mailboxIds: [] })).toBe(true);
	});
});
